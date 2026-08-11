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
) {
    std::thread::spawn(move || {
        if let Err(e) = run(&app, &db_path, &root, &generation, my_gen) {
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
    Ok(())
}
