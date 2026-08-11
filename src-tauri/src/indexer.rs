use crate::{db, metadata};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub scanned: u64,
    pub indexed: u64,
    pub total: Option<u64>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_path: Option<String>,
}

struct Found {
    path: PathBuf,
    name: String,
    ext: Option<String>,
    kind: &'static str,
    size: i64,
    mtime: i64,
}

fn emit(app: &AppHandle, p: Progress) {
    let _ = app.emit("index-progress", p);
}

fn file_mtime(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Spawn a background thread that (re)indexes `root` into the SQLite db.
/// If `generation` no longer equals `my_gen`, the run aborts early — this lets
/// a newer request (folder switch / rescan) supersede an in-flight one.
pub fn spawn(
    app: AppHandle,
    db_path: PathBuf,
    root: PathBuf,
    generation: Arc<AtomicU64>,
    my_gen: u64,
    vision_helper: Option<PathBuf>,
) {
    std::thread::spawn(move || {
        if let Err(e) = run(&app, &db_path, &root, &generation, my_gen, vision_helper) {
            eprintln!("indexing error: {e}");
            emit(
                &app,
                Progress {
                    scanned: 0,
                    indexed: 0,
                    total: None,
                    done: true,
                    current_path: None,
                },
            );
        }
    });
}

fn superseded(generation: &Arc<AtomicU64>, my_gen: u64) -> bool {
    generation.load(Ordering::Relaxed) != my_gen
}

fn run(
    app: &AppHandle,
    db_path: &Path,
    root: &Path,
    generation: &Arc<AtomicU64>,
    my_gen: u64,
    vision_helper: Option<PathBuf>,
) -> rusqlite::Result<()> {
    let mut conn = db::open(db_path)?;

    // ---- Phase 1: walk the tree and collect media files (fast, no parsing).
    let mut found: Vec<Found> = Vec::new();
    let mut scanned: u64 = 0;
    for entry in jwalk::WalkDir::new(root).skip_hidden(true) {
        if superseded(generation, my_gen) {
            return Ok(());
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        let kind = metadata::classify(ext.as_deref().unwrap_or(""));
        if !metadata::is_media(kind) {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        found.push(Found {
            path,
            name,
            ext,
            kind,
            size: md.len() as i64,
            mtime: file_mtime(&md),
        });
        scanned += 1;
        if scanned % 500 == 0 {
            emit(
                app,
                Progress {
                    scanned,
                    indexed: 0,
                    total: None,
                    done: false,
                    current_path: None,
                },
            );
        }
    }

    let total = found.len() as u64;

    // Bump when the extracted columns change so existing rows get re-extracted
    // once (the mtime fast-path is skipped for that run).
    const INDEX_VER: i64 = 3;
    let stored_ver: i64 = conn
        .query_row("SELECT v FROM meta WHERE k='index_ver'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let full_reextract = stored_ver != INDEX_VER;

    // ---- Phase 2: extract capture dates + metadata and upsert in batches.
    let mut indexed: u64 = 0;
    let mut i = 0usize;
    const BATCH: usize = 400;

    while i < found.len() {
        if superseded(generation, my_gen) {
            return Ok(());
        }
        let end = (i + BATCH).min(found.len());
        {
            let tx = conn.transaction()?;
            {
                let mut sel = tx.prepare("SELECT mtime FROM assets WHERE path = ?1")?;
                let mut ins = tx.prepare(
                    r#"INSERT INTO assets
                        (path, name, ext, kind, size, mtime, capture_ts, year, month, day,
                         camera, width, height, lat, lon, place_city, place_country, seen)
                       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                       ON CONFLICT(path) DO UPDATE SET
                        name=excluded.name, ext=excluded.ext, kind=excluded.kind,
                        size=excluded.size, mtime=excluded.mtime, capture_ts=excluded.capture_ts,
                        year=excluded.year, month=excluded.month, day=excluded.day,
                        camera=excluded.camera, width=excluded.width, height=excluded.height,
                        lat=excluded.lat, lon=excluded.lon,
                        place_city=excluded.place_city, place_country=excluded.place_country,
                        vision_done=0,
                        seen=excluded.seen"#,
                )?;
                let mut touch = tx.prepare("UPDATE assets SET seen = ?2 WHERE path = ?1")?;

                for f in &found[i..end] {
                    let path_str = f.path.to_string_lossy().to_string();
                    // Fast path: unchanged file — just mark it seen this generation.
                    let existing: Option<i64> = sel.query_row([&path_str], |r| r.get(0)).ok();
                    if !full_reextract && existing == Some(f.mtime) {
                        touch.execute(rusqlite::params![path_str, my_gen as i64])?;
                    } else {
                        let mut camera = None;
                        let mut width = None;
                        let mut height = None;
                        let mut lat: Option<f64> = None;
                        let mut lon: Option<f64> = None;
                        let ts = match f.kind {
                            "image" => {
                                let ex = metadata::extract_exif(&f.path);
                                camera = ex.camera;
                                width = ex.width;
                                height = ex.height;
                                lat = ex.lat;
                                lon = ex.lon;
                                ex.datetime.unwrap_or(f.mtime)
                            }
                            "video" => metadata::mp4_creation(&f.path).unwrap_or(f.mtime),
                            _ => f.mtime,
                        };
                        let (city, country) = match (lat, lon) {
                            (Some(la), Some(lo)) => crate::places::geocode(la, lo),
                            _ => (None, None),
                        };
                        let (year, month, day) = metadata::ymd(ts, f.mtime);
                        ins.execute(rusqlite::params![
                            path_str,
                            f.name,
                            f.ext,
                            f.kind,
                            f.size,
                            f.mtime,
                            ts,
                            year,
                            month,
                            day,
                            camera,
                            width,
                            height,
                            lat,
                            lon,
                            city,
                            country,
                            my_gen as i64,
                        ])?;
                    }
                    indexed += 1;
                }
            }
            tx.commit()?;
        }
        emit(
            app,
            Progress {
                scanned,
                indexed,
                total: Some(total),
                done: false,
                current_path: found.get(end - 1).map(|f| f.name.clone()),
            },
        );
        i = end;
    }

    if superseded(generation, my_gen) {
        return Ok(());
    }

    // ---- Remove rows for files that vanished since this generation started.
    conn.execute(
        "DELETE FROM assets WHERE seen != ?1",
        rusqlite::params![my_gen as i64],
    )?;

    // Record the final asset count for this folder's recents entry.
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap_or(0);
    let _ = conn.execute(
        "UPDATE recents SET count=?1 WHERE path=?2",
        rusqlite::params![count, root.to_string_lossy().to_string()],
    );
    let _ = conn.execute(
        "INSERT INTO meta(k,v) VALUES('index_ver',?1)
         ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        [INDEX_VER.to_string()],
    );

    emit(
        app,
        Progress {
            scanned,
            indexed,
            total: Some(total),
            done: true,
            current_path: None,
        },
    );

    // ---- Second pass: enrich images with Vision scene labels + OCR text.
    if let Some(helper) = vision_helper.as_ref() {
        if helper.exists() && !superseded(generation, my_gen) {
            let _ = enrich_vision(app, &mut conn, generation, my_gen, helper);
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct VisionProgress {
    processed: i64,
    total: i64,
    done: bool,
}

fn emit_vision(app: &AppHandle, processed: i64, total: i64, done: bool) {
    let _ = app.emit(
        "vision-progress",
        VisionProgress {
            processed,
            total,
            done,
        },
    );
}

/// Run the Vision helper over images lacking analysis, storing scene labels and
/// OCR text. Batched so the model loads once per batch; cancels if superseded.
fn enrich_vision(
    app: &AppHandle,
    conn: &mut rusqlite::Connection,
    generation: &Arc<AtomicU64>,
    my_gen: u64,
    helper: &Path,
) -> rusqlite::Result<()> {
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE kind='image' AND vision_done=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if total == 0 {
        return Ok(());
    }
    // OCR quality setting: "accurate" (default) unless the user chose "fast".
    let accurate = conn
        .query_row("SELECT v FROM meta WHERE k='vision_quality'", [], |r| {
            r.get::<_, String>(0)
        })
        .map(|v| v != "fast")
        .unwrap_or(true);
    let mut processed = 0i64;
    loop {
        if superseded(generation, my_gen) {
            return Ok(());
        }
        let batch: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, path FROM assets WHERE kind='image' AND vision_done=0 LIMIT 128",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            rows.filter_map(Result::ok).collect()
        };
        if batch.is_empty() {
            break;
        }
        let paths: Vec<String> = batch.iter().map(|(_, p)| p.clone()).collect();
        let results = crate::vision::run_batch(helper, &paths, accurate);

        let tx = conn.transaction()?;
        {
            let mut upd = tx.prepare("UPDATE assets SET ocr=?1, vision_done=1 WHERE id=?2")?;
            let mut del_lbl = tx.prepare("DELETE FROM asset_labels WHERE asset_id=?1")?;
            let mut ins_lbl =
                tx.prepare("INSERT OR IGNORE INTO asset_labels(asset_id, label) VALUES(?1,?2)")?;
            let mut del_face = tx.prepare("DELETE FROM faces WHERE asset_id=?1")?;
            let mut ins_face = tx.prepare(
                "INSERT INTO faces(asset_id,x,y,w,h,embedding,cluster_id) \
                 VALUES(?1,?2,?3,?4,?5,?6,NULL)",
            )?;
            for (id, path) in &batch {
                let data = results.get(path);
                let text = data.map(|d| d.text.as_str()).unwrap_or("");
                upd.execute(rusqlite::params![text, id])?;
                del_lbl.execute([id])?;
                del_face.execute([id])?;
                if let Some(d) = data {
                    for label in &d.labels {
                        ins_lbl.execute(rusqlite::params![id, label])?;
                    }
                    for f in &d.faces {
                        ins_face.execute(rusqlite::params![id, f.x, f.y, f.w, f.h, f.embedding])?;
                    }
                }
            }
        }
        tx.commit()?;
        processed += batch.len() as i64;
        emit_vision(app, processed.min(total), total, false);
    }

    if !superseded(generation, my_gen) {
        cluster_faces(conn)?;
    }
    emit_vision(app, total, total, true);
    Ok(())
}

/// Greedy incremental face clustering: each unclustered face joins the nearest
/// existing cluster within a cosine-distance threshold, or starts a new one.
/// Best-effort — the embeddings are Vision feature prints, not face-tuned.
fn cluster_faces(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    const THRESHOLD: f32 = 0.32; // cosine distance; smaller = stricter

    // Seed centroids from already-clustered faces.
    let mut centroids: Vec<(i64, Vec<f32>, u32)> = Vec::new(); // (cluster_id, centroid, count)
    {
        let mut stmt =
            conn.prepare("SELECT cluster_id, embedding FROM faces WHERE cluster_id IS NOT NULL")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?;
        for row in rows {
            let (cid, bytes) = row?;
            let v = normalize(bytes_to_f32(&bytes));
            if v.is_empty() {
                continue;
            }
            if let Some(c) = centroids.iter_mut().find(|c| c.0 == cid) {
                add_into(&mut c.1, &v);
                c.2 += 1;
            } else {
                centroids.push((cid, v, 1));
            }
        }
    }
    let mut next_id: i64 = conn
        .query_row("SELECT COALESCE(MAX(cluster_id),0) FROM faces", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);

    let pending: Vec<(i64, Vec<u8>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, embedding FROM faces WHERE cluster_id IS NULL AND embedding IS NOT NULL",
        )?;
        let rows =
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        rows.filter_map(Result::ok).collect()
    };
    if pending.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut assign = tx.prepare("UPDATE faces SET cluster_id=?1 WHERE id=?2")?;
        let mut new_person =
            tx.prepare("INSERT OR IGNORE INTO people(cluster_id, name) VALUES(?1, NULL)")?;
        for (face_id, bytes) in &pending {
            let v = normalize(bytes_to_f32(bytes));
            if v.is_empty() {
                continue;
            }
            // nearest centroid
            let mut best = f32::MAX;
            let mut best_idx: Option<usize> = None;
            for (i, c) in centroids.iter().enumerate() {
                let mean = scaled(&c.1, 1.0 / c.2 as f32);
                let d = cosine_distance(&v, &normalize(mean));
                if d < best {
                    best = d;
                    best_idx = Some(i);
                }
            }
            let cid = if best <= THRESHOLD {
                let i = best_idx.unwrap();
                add_into(&mut centroids[i].1, &v);
                centroids[i].2 += 1;
                centroids[i].0
            } else {
                next_id += 1;
                centroids.push((next_id, v, 1));
                new_person.execute([next_id])?;
                next_id
            };
            assign.execute(rusqlite::params![cid, face_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn bytes_to_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-6 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

fn add_into(acc: &mut [f32], v: &[f32]) {
    for (a, b) in acc.iter_mut().zip(v) {
        *a += *b;
    }
}

fn scaled(v: &[f32], s: f32) -> Vec<f32> {
    v.iter().map(|x| x * s).collect()
}

fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return f32::MAX;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    1.0 - dot
}
