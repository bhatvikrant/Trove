use crate::{db, metadata};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Wall-clock for one analysis run (index pass + Vision pass). Every progress
/// event carries the run's id and how long it has been going, so the UI can run
/// a live elapsed timer — and pick the count back up mid-run after a reload.
#[derive(Clone, Copy)]
struct Clock {
    run_id: u64,
    started: Instant,
}

impl Clock {
    fn new(run_id: u64) -> Self {
        Self {
            run_id,
            started: Instant::now(),
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// The run in flight, if any. Indexing outlives the screen that started it — the
/// user can go back to the welcome screen while it keeps going, and a launch
/// resumes the last folder before any screen exists — so a run publishes its
/// state here instead of the UI having to infer it from events it happened to
/// hear. `None` means nothing is indexing.
pub type Active = Arc<Mutex<Option<IndexStatus>>>;

/// A snapshot of the run in flight, readable at any moment via
/// `get_index_status`. `root` is what lets the welcome screen put the progress
/// on the right recent-folder tile.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub run_id: u64,
    pub root: String,
    /// How long the run has been going, as of its last report.
    pub elapsed_ms: u64,
    #[serde(skip)]
    started: Instant,
    /// `indexing` while walking the tree and reading metadata; `analyzing`
    /// during the Vision pass that follows.
    pub phase: &'static str,
    pub scanned: u64,
    pub indexed: u64,
    pub total: Option<u64>,
    pub processed: i64,
    pub vision_total: i64,
}

impl IndexStatus {
    /// A copy whose `elapsed_ms` is current. The stored value is only as fresh
    /// as the last report, which is seconds old during a long directory walk.
    pub fn refreshed(&self) -> Self {
        Self {
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            ..self.clone()
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub run_id: u64,
    /// The folder being indexed — not necessarily the one on screen.
    pub root: String,
    pub elapsed_ms: u64,
    pub scanned: u64,
    pub indexed: u64,
    pub total: Option<u64>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_path: Option<String>,
}

/// Emitted once when a run finishes everything it had to do (index + Vision +
/// sidecar). `durationMs` is what gets persisted for the folder.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisDone {
    run_id: u64,
    root: String,
    duration_ms: u64,
    finished_at: i64,
}

/// Emitted when a run is stopped before it finished — the user pressed Stop, or
/// the folder was closed out from under it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancelled {
    pub run_id: u64,
    pub root: String,
}

struct Found {
    path: PathBuf,
    name: String,
    ext: Option<String>,
    kind: &'static str,
    size: i64,
    mtime: i64,
}

/// Metadata read off disk for one file, ready to be written. `idx` points back
/// into the `found` list for the fields that came from the directory walk.
struct Extracted {
    idx: usize,
    path: String,
    camera: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    lat: Option<f64>,
    lon: Option<f64>,
    city: Option<String>,
    country: Option<String>,
    ts: i64,
    year: i32,
    month: u32,
    day: u32,
}

/// One prepared write for the batch's transaction — no file I/O left to do.
enum Pending {
    /// Unchanged file: just mark it seen for this generation.
    Touch(String),
    Upsert(Extracted),
}

/// Take over the shared slot — unless a newer run already owns it. A superseded
/// run keeps working until it reaches its next checkpoint, and without this its
/// trailing reports would overwrite the status of the run that replaced it.
fn publish_into(active: &Active, status: IndexStatus) {
    let mut slot = active.lock().unwrap();
    match slot.as_ref() {
        Some(cur) if cur.run_id > status.run_id => {}
        _ => *slot = Some(status),
    }
}

/// Release the shared slot, if `run_id` still owns it. Same reason: a run that
/// ends after being superseded must leave its successor's status alone.
fn clear_if_owner(active: &Active, run_id: u64) {
    let mut slot = active.lock().unwrap();
    if slot.as_ref().is_some_and(|cur| cur.run_id == run_id) {
        *slot = None;
    }
}

/// How a run talks to the rest of the app: it emits progress events *and* keeps
/// the shared `Active` slot up to date, so a screen that wasn't listening (or
/// didn't exist yet) can still ask what's going on.
struct Reporter {
    app: AppHandle,
    clock: Clock,
    root: String,
    active: Active,
}

impl Reporter {
    fn new(app: AppHandle, clock: Clock, root: String, active: Active) -> Self {
        Self {
            app,
            clock,
            root,
            active,
        }
    }

    fn publish(&self, status: IndexStatus) {
        publish_into(&self.active, status);
    }

    fn clear(&self) {
        clear_if_owner(&self.active, self.clock.run_id);
    }

    fn snapshot(&self, phase: &'static str) -> IndexStatus {
        IndexStatus {
            run_id: self.clock.run_id,
            root: self.root.clone(),
            elapsed_ms: self.clock.elapsed_ms(),
            started: self.clock.started,
            phase,
            scanned: 0,
            indexed: 0,
            total: None,
            processed: 0,
            vision_total: 0,
        }
    }

    fn index(
        &self,
        scanned: u64,
        indexed: u64,
        total: Option<u64>,
        done: bool,
        current_path: Option<String>,
    ) {
        let status = IndexStatus {
            scanned,
            indexed,
            total,
            ..self.snapshot("indexing")
        };
        let elapsed_ms = status.elapsed_ms;
        self.publish(status);
        let _ = self.app.emit(
            "index-progress",
            Progress {
                run_id: self.clock.run_id,
                root: self.root.clone(),
                elapsed_ms,
                scanned,
                indexed,
                total,
                done,
                current_path,
            },
        );
    }

    fn vision(&self, processed: i64, total: i64, done: bool) {
        let status = IndexStatus {
            processed,
            vision_total: total,
            ..self.snapshot("analyzing")
        };
        let elapsed_ms = status.elapsed_ms;
        self.publish(status);
        let _ = self.app.emit(
            "vision-progress",
            VisionProgress {
                run_id: self.clock.run_id,
                root: self.root.clone(),
                elapsed_ms,
                processed,
                total,
                done,
            },
        );
    }

    /// Tell the UI the run is over and how long it took. `store` also records
    /// the duration against the folder, so it can still be shown after a restart
    /// — pass it only for a run that actually finished its work.
    fn finish(&self, store: Option<(&rusqlite::Connection, &Path)>) {
        let duration_ms = self.clock.elapsed_ms();
        let finished_at = crate::now_unix();
        if let Some((conn, root)) = store {
            let _ = conn.execute(
                "UPDATE recents SET analysis_ms=?1, analyzed_at=?2 WHERE path=?3",
                rusqlite::params![
                    duration_ms as i64,
                    finished_at,
                    root.to_string_lossy().to_string()
                ],
            );
        }
        self.clear();
        let _ = self.app.emit(
            "analysis-done",
            AnalysisDone {
                run_id: self.clock.run_id,
                root: self.root.clone(),
                duration_ms,
                finished_at,
            },
        );
    }
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
/// a newer request (folder switch / rescan / Stop) supersede an in-flight one.
///
/// The run is published to `active` synchronously, before the thread starts, so
/// a status query made right after this returns already sees the folder as busy.
pub fn spawn(
    app: AppHandle,
    db_path: PathBuf,
    root: PathBuf,
    generation: Arc<AtomicU64>,
    my_gen: u64,
    vision_helper: Option<PathBuf>,
    active: Active,
) {
    let rep = Reporter::new(
        app,
        Clock::new(my_gen),
        root.to_string_lossy().to_string(),
        active,
    );
    rep.index(0, 0, None, false, None);
    std::thread::spawn(move || {
        if let Err(e) = run(&rep, &db_path, &root, &generation, my_gen, vision_helper) {
            eprintln!("indexing error: {e}");
            rep.index(0, 0, None, true, None);
            // Stop the UI's timer, but don't record a failed run as this
            // folder's analysis time.
            rep.finish(None);
        }
    });
}

fn superseded(generation: &Arc<AtomicU64>, my_gen: u64) -> bool {
    generation.load(Ordering::Relaxed) != my_gen
}

fn run(
    rep: &Reporter,
    db_path: &Path,
    root: &Path,
    generation: &Arc<AtomicU64>,
    my_gen: u64,
    vision_helper: Option<PathBuf>,
) -> rusqlite::Result<()> {
    let mut conn = db::open(db_path)?;

    // Seed favorites + face names from a portable sidecar (e.g. this folder was
    // curated on another Mac). Harmless when there's no sidecar.
    crate::sidecar::import_curation(&conn, root);

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
            rep.index(scanned, 0, None, false, None);
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
    //
    // Metadata extraction reads from disk (EXIF headers, MP4 `moov` atoms) and is
    // by far the slow part of a batch. It deliberately happens *outside* the write
    // transaction: SQLite allows a single writer, so a transaction that parses
    // hundreds of files while holding the write lock blocks the UI connection for
    // seconds — long enough for a command like `set_root` to give up with
    // "database is locked". Now the lock is only held for the statements.
    let mut indexed: u64 = 0;
    let mut i = 0usize;
    const BATCH: usize = 400;

    while i < found.len() {
        if superseded(generation, my_gen) {
            return Ok(());
        }
        let end = (i + BATCH).min(found.len());

        // Stored mtimes for this batch (read-only: readers never block in WAL).
        let mut known: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        {
            let mut sel = conn.prepare("SELECT mtime FROM assets WHERE path = ?1")?;
            for f in &found[i..end] {
                let path_str = f.path.to_string_lossy().to_string();
                if let Ok(mtime) = sel.query_row([&path_str], |r| r.get::<_, i64>(0)) {
                    known.insert(path_str, mtime);
                }
            }
        }

        // Slow, lock-free pass: parse whatever changed.
        let mut pending: Vec<Pending> = Vec::with_capacity(end - i);
        for (n, f) in found[i..end].iter().enumerate() {
            let path_str = f.path.to_string_lossy().to_string();
            // Fast path: unchanged file — just mark it seen this generation.
            if !full_reextract && known.get(&path_str) == Some(&f.mtime) {
                pending.push(Pending::Touch(path_str));
                continue;
            }
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
            pending.push(Pending::Upsert(Extracted {
                idx: i + n,
                path: path_str,
                camera,
                width,
                height,
                lat,
                lon,
                city,
                country,
                ts,
                year,
                month,
                day,
            }));
        }

        // A folder switch / rescan while we were parsing supersedes this batch;
        // writing it would resurrect rows for a folder the user left.
        if superseded(generation, my_gen) {
            return Ok(());
        }

        {
            let tx = db::write_tx(&mut conn)?;
            {
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

                for p in &pending {
                    match p {
                        Pending::Touch(path_str) => {
                            touch.execute(rusqlite::params![path_str, my_gen as i64])?;
                        }
                        Pending::Upsert(e) => {
                            let f = &found[e.idx];
                            ins.execute(rusqlite::params![
                                e.path,
                                f.name,
                                f.ext,
                                f.kind,
                                f.size,
                                f.mtime,
                                e.ts,
                                e.year,
                                e.month,
                                e.day,
                                e.camera,
                                e.width,
                                e.height,
                                e.lat,
                                e.lon,
                                e.city,
                                e.country,
                                my_gen as i64,
                            ])?;
                        }
                    }
                    indexed += 1;
                }
            }
            tx.commit()?;
        }
        rep.index(
            scanned,
            indexed,
            Some(total),
            false,
            found.get(end - 1).map(|f| f.name.clone()),
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

    // ---- Restore favorites from the durable, path-keyed table (fresh rows
    // default to favorite=0, so re-index would otherwise lose them).
    conn.execute(
        "UPDATE assets SET favorite = 1
         WHERE path IN (SELECT path FROM favorites)",
        [],
    )?;

    // ---- Restore cached Vision analysis from the portable sidecar for any
    // unchanged file, so it isn't re-analyzed here or on another machine. Then
    // reattach names to the restored clusters (in case no new media follows).
    crate::sidecar::restore_analysis(&mut conn, root);
    reattach_names(&conn)?;

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

    rep.index(scanned, indexed, Some(total), true, None);

    // ---- Second pass: enrich images with Vision scene labels + OCR text.
    let mut analyzed = 0i64;
    if let Some(helper) = vision_helper.as_ref() {
        if helper.exists() && !superseded(generation, my_gen) {
            analyzed = enrich_vision(rep, &mut conn, generation, my_gen, helper).unwrap_or(0);
        }
    }

    // Refresh the portable cache only when new media was actually analyzed
    // (avoids rewriting the whole cache on every incremental launch). Favorites
    // and names are written through by their own commands, not here.
    if analyzed > 0 && !superseded(generation, my_gen) && crate::sidecar::enabled(&conn) {
        crate::sidecar::export_analysis(&conn, root);
    }

    // Everything this run had to do is done: record how long the folder took.
    if !superseded(generation, my_gen) {
        rep.finish(Some((&conn, root)));
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisionProgress {
    run_id: u64,
    root: String,
    elapsed_ms: u64,
    processed: i64,
    total: i64,
    done: bool,
}

/// Run the Vision helper over images lacking analysis, storing scene labels and
/// OCR text. Batched so the model loads once per batch; cancels if superseded.
fn enrich_vision(
    rep: &Reporter,
    conn: &mut rusqlite::Connection,
    generation: &Arc<AtomicU64>,
    my_gen: u64,
    helper: &Path,
) -> rusqlite::Result<i64> {
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE kind='image' AND vision_done=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if total == 0 {
        return Ok(0);
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
            return Ok(processed);
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

        // The helper call above is the longest uninterruptible stretch of a run;
        // a Stop or folder switch during it means these results belong to a run
        // nobody is waiting for, so drop them rather than write them.
        if superseded(generation, my_gen) {
            return Ok(processed);
        }

        // run_batch is the slow part and ran above, outside the transaction.
        let tx = db::write_tx(conn)?;
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
        rep.vision(processed.min(total), total, false);
    }

    if superseded(generation, my_gen) {
        return Ok(processed);
    }
    cluster_faces(conn)?;
    rep.vision(total, total, true);
    Ok(processed)
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

    // Assign every face first — the distance maths is pure CPU work and can run
    // for a while, so it must not hold the SQLite write lock (see phase 2).
    let mut assignments: Vec<(i64, i64)> = Vec::with_capacity(pending.len()); // (cluster, face)
    let mut fresh_clusters: Vec<i64> = Vec::new();
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
            fresh_clusters.push(next_id);
            next_id
        };
        assignments.push((cid, *face_id));
    }

    let tx = db::write_tx(conn)?;
    {
        let mut assign = tx.prepare("UPDATE faces SET cluster_id=?1 WHERE id=?2")?;
        let mut new_person =
            tx.prepare("INSERT OR IGNORE INTO people(cluster_id, name) VALUES(?1, NULL)")?;
        for cid in &fresh_clusters {
            new_person.execute([cid])?;
        }
        for (cid, face_id) in &assignments {
            assign.execute(rusqlite::params![cid, face_id])?;
        }
    }
    tx.commit()?;

    // Reattach names the user gave before this re-index (see reattach_names).
    reattach_names(conn)?;
    Ok(())
}

/// Reapply user-assigned person names after (re)clustering. Names are stored
/// durably in `named_faces`, keyed by file path + face centre, so a folder that
/// gets re-indexed (fresh cluster ids) gets its labels back: for each cluster,
/// take the most common stored name across its faces. Also prunes `people` rows
/// whose clusters no longer exist.
fn reattach_names(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;
    let clusters: Vec<i64> = {
        let mut stmt =
            conn.prepare("SELECT DISTINCT cluster_id FROM faces WHERE cluster_id IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        rows.filter_map(Result::ok).collect()
    };
    for cid in clusters {
        let name: Option<String> = conn
            .query_row(
                "SELECT nf.name FROM faces f
                 JOIN assets a ON a.id = f.asset_id
                 JOIN named_faces nf
                   ON nf.path = a.path
                  AND ROUND(f.x + f.w/2.0, 3) = nf.cx
                  AND ROUND(f.y + f.h/2.0, 3) = nf.cy
                 WHERE f.cluster_id = ?1
                 GROUP BY nf.name
                 ORDER BY COUNT(*) DESC
                 LIMIT 1",
                [cid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(n) = name {
            conn.execute(
                "INSERT INTO people(cluster_id, name) VALUES(?1, ?2)
                 ON CONFLICT(cluster_id) DO UPDATE SET name = excluded.name",
                rusqlite::params![cid, n],
            )?;
        }
    }
    conn.execute(
        "DELETE FROM people WHERE cluster_id NOT IN
            (SELECT DISTINCT cluster_id FROM faces WHERE cluster_id IS NOT NULL)",
        [],
    )?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn status(run_id: u64, root: &str) -> IndexStatus {
        IndexStatus {
            run_id,
            root: root.into(),
            elapsed_ms: 0,
            started: Instant::now(),
            phase: "indexing",
            scanned: 0,
            indexed: 0,
            total: None,
            processed: 0,
            vision_total: 0,
        }
    }

    fn owner(active: &Active) -> Option<(u64, String)> {
        active
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| (s.run_id, s.root.clone()))
    }

    /// The welcome screen names the folder being indexed from this slot, so a
    /// superseded run reporting one last batch must not put its own folder back.
    #[test]
    fn a_superseded_run_cannot_reclaim_the_slot() {
        let active: Active = Arc::new(Mutex::new(None));

        publish_into(&active, status(1, "/old"));
        publish_into(&active, status(2, "/new")); // folder switch
        publish_into(&active, status(1, "/old")); // run 1's trailing report
        assert_eq!(owner(&active), Some((2, "/new".to_string())));

        // ...and when it finally notices and exits, it leaves run 2 running.
        clear_if_owner(&active, 1);
        assert_eq!(owner(&active), Some((2, "/new".to_string())));

        clear_if_owner(&active, 2);
        assert_eq!(owner(&active), None);
    }

    /// A fresh run takes over a slot the previous one never got to release.
    #[test]
    fn a_newer_run_takes_over_a_stale_slot() {
        let active: Active = Arc::new(Mutex::new(None));
        publish_into(&active, status(4, "/old"));
        publish_into(&active, status(5, "/new"));
        assert_eq!(owner(&active), Some((5, "/new".to_string())));
    }
}
