// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod indexer;
mod metadata;
mod thumbs;

use chrono::{Duration, Local, NaiveDate, TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{Manager, State};

struct AppState {
    db: Mutex<Connection>,
    db_path: PathBuf,
    cache_dir: PathBuf,
    root: Mutex<Option<PathBuf>>,
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    id: i64,
    path: String,
    name: String,
    ext: Option<String>,
    kind: String,
    size: i64,
    mtime: i64,
    capture_ts: i64,
    year: i32,
    month: u32,
    day: u32,
}

#[derive(Serialize)]
struct KindCount {
    kind: String,
    count: i64,
}

#[derive(Serialize)]
struct DayNode {
    day: u32,
    count: i64,
    kinds: Vec<KindCount>,
}

#[derive(Serialize)]
struct MonthNode {
    month: u32,
    count: i64,
    days: Vec<DayNode>,
}

#[derive(Serialize)]
struct YearNode {
    year: i32,
    count: i64,
    months: Vec<MonthNode>,
}

#[derive(Serialize)]
struct DateTree {
    total: i64,
    years: Vec<YearNode>,
}

#[derive(Deserialize, Default)]
struct DateRange {
    start: Option<String>,
    end: Option<String>,
}

/// Convert an inclusive local date range into [start_unix, end_unix) bounds.
fn range_bounds(range: &Option<DateRange>) -> (Option<i64>, Option<i64>) {
    let mut lo = None;
    let mut hi = None;
    if let Some(r) = range {
        if let Some(s) = &r.start {
            if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                if let Some(dt) = Local
                    .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
                    .single()
                {
                    lo = Some(dt.timestamp());
                }
            }
        }
        if let Some(e) = &r.end {
            if let Ok(d) = NaiveDate::parse_from_str(e, "%Y-%m-%d") {
                let next = d + Duration::days(1);
                if let Some(dt) = Local
                    .from_local_datetime(&next.and_hms_opt(0, 0, 0).unwrap())
                    .single()
                {
                    hi = Some(dt.timestamp());
                }
            }
        }
    }
    (lo, hi)
}

fn start_indexing(state: &AppState, app: &tauri::AppHandle, root: PathBuf) {
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    indexer::spawn(
        app.clone(),
        state.db_path.clone(),
        root,
        state.generation.clone(),
        my_gen,
    );
}

#[tauri::command]
fn set_root(path: String, state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    {
        let conn = state.db.lock().unwrap();
        conn.execute("DELETE FROM assets", []).map_err(e2s)?;
        conn.execute(
            "INSERT INTO meta(k,v) VALUES('root',?1)
             ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            [&path],
        )
        .map_err(e2s)?;
    }
    *state.root.lock().unwrap() = Some(root.clone());
    start_indexing(&state, &app, root);
    Ok(())
}

#[tauri::command]
fn rescan(state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let root = state.root.lock().unwrap().clone();
    match root {
        Some(r) => {
            start_indexing(&state, &app, r);
            Ok(())
        }
        None => Err("No folder is open".into()),
    }
}

#[tauri::command]
fn get_date_tree(range: Option<DateRange>, state: State<AppState>) -> Result<DateTree, String> {
    let (lo, hi) = range_bounds(&range);
    let conn = state.db.lock().unwrap();
    query_date_tree(&conn, lo, hi).map_err(e2s)
}

fn query_date_tree(
    conn: &Connection,
    lo: Option<i64>,
    hi: Option<i64>,
) -> rusqlite::Result<DateTree> {
    let mut conds: Vec<&str> = Vec::new();
    let mut args: Vec<i64> = Vec::new();
    if lo.is_some() {
        conds.push("capture_ts >= ?");
        args.push(lo.unwrap());
    }
    if hi.is_some() {
        conds.push("capture_ts < ?");
        args.push(hi.unwrap());
    }
    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    };
    let sql = format!(
        "SELECT year, month, day, kind, COUNT(*) FROM assets{} \
         GROUP BY year, month, day, kind \
         ORDER BY year DESC, month DESC, day DESC, kind ASC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok((
            r.get::<_, i32>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, u32>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;

    let mut tree = DateTree {
        total: 0,
        years: Vec::new(),
    };
    for row in rows {
        let (y, m, d, kind, cnt) = row?;
        tree.total += cnt;
        if tree.years.last().map(|n| n.year) != Some(y) {
            tree.years.push(YearNode {
                year: y,
                count: 0,
                months: Vec::new(),
            });
        }
        let yr = tree.years.last_mut().unwrap();
        yr.count += cnt;
        if yr.months.last().map(|n| n.month) != Some(m) {
            yr.months.push(MonthNode {
                month: m,
                count: 0,
                days: Vec::new(),
            });
        }
        let mo = yr.months.last_mut().unwrap();
        mo.count += cnt;
        if mo.days.last().map(|n| n.day) != Some(d) {
            mo.days.push(DayNode {
                day: d,
                count: 0,
                kinds: Vec::new(),
            });
        }
        let da = mo.days.last_mut().unwrap();
        da.count += cnt;
        da.kinds.push(KindCount { kind, count: cnt });
    }
    Ok(tree)
}

fn map_asset(r: &rusqlite::Row) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: r.get(0)?,
        path: r.get(1)?,
        name: r.get(2)?,
        ext: r.get(3)?,
        kind: r.get(4)?,
        size: r.get(5)?,
        mtime: r.get(6)?,
        capture_ts: r.get(7)?,
        year: r.get(8)?,
        month: r.get(9)?,
        day: r.get(10)?,
    })
}

const ASSET_COLS: &str =
    "id, path, name, ext, kind, size, mtime, capture_ts, year, month, day";

#[tauri::command]
fn list_assets(
    year: i32,
    month: u32,
    day: u32,
    kind: Option<String>,
    range: Option<DateRange>,
    state: State<AppState>,
) -> Result<Vec<Asset>, String> {
    let (lo, hi) = range_bounds(&range);
    let conn = state.db.lock().unwrap();

    let mut conds: Vec<String> = vec![
        "year = ?".into(),
        "month = ?".into(),
        "day = ?".into(),
    ];
    let mut ints: Vec<i64> = vec![year as i64, month as i64, day as i64];
    let mut kind_val: Option<String> = None;
    if let Some(k) = kind {
        conds.push("kind = ?".into());
        kind_val = Some(k);
    }
    if let Some(lo) = lo {
        conds.push("capture_ts >= ?".into());
        ints.push(lo);
    }
    if let Some(hi) = hi {
        conds.push("capture_ts < ?".into());
        ints.push(hi);
    }

    let sql = format!(
        "SELECT {ASSET_COLS} FROM assets WHERE {} ORDER BY capture_ts ASC, name COLLATE NOCASE ASC",
        conds.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).map_err(e2s)?;

    // Bind params in the exact order the conditions were pushed.
    let mut binds: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    binds.push(Box::new(year as i64));
    binds.push(Box::new(month as i64));
    binds.push(Box::new(day as i64));
    if let Some(k) = kind_val {
        binds.push(Box::new(k));
    }
    if let Some(lo) = lo {
        binds.push(Box::new(lo));
    }
    if let Some(hi) = hi {
        binds.push(Box::new(hi));
    }

    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(binds.iter().map(|b| b.as_ref())),
            map_asset,
        )
        .map_err(e2s)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(e2s)?);
    }
    Ok(out)
}

#[tauri::command]
fn search_assets(
    query: String,
    range: Option<DateRange>,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<Asset>, String> {
    let (lo, hi) = range_bounds(&range);
    let conn = state.db.lock().unwrap();

    let like = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
    let mut sql = format!("SELECT {ASSET_COLS} FROM assets WHERE name LIKE ?1 ESCAPE '\\'");
    let mut binds: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(like)];
    if let Some(lo) = lo {
        sql.push_str(&format!(" AND capture_ts >= ?{}", binds.len() + 1));
        binds.push(Box::new(lo));
    }
    if let Some(hi) = hi {
        sql.push_str(&format!(" AND capture_ts < ?{}", binds.len() + 1));
        binds.push(Box::new(hi));
    }
    sql.push_str(&format!(
        " ORDER BY capture_ts DESC LIMIT ?{}",
        binds.len() + 1
    ));
    binds.push(Box::new(limit));

    let mut stmt = conn.prepare(&sql).map_err(e2s)?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(binds.iter().map(|b| b.as_ref())),
            map_asset,
        )
        .map_err(e2s)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(e2s)?);
    }
    Ok(out)
}

#[tauri::command]
fn get_thumb(path: String, size: u32, state: State<AppState>) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let kind = metadata::classify(&ext);
    let mtime = std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let thumb = thumbs::ensure(&state.cache_dir, &path, kind, mtime, size.clamp(48, 1024));
    Ok(thumb.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(e2s)?;
    Ok(())
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir");
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("index.sqlite");
            let cache_dir = dir.join("thumbnails");
            std::fs::create_dir_all(&cache_dir)?;

            let conn = db::open(&db_path).expect("failed to open index db");
            let saved_root: Option<PathBuf> = conn
                .query_row("SELECT v FROM meta WHERE k='root'", [], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
                .map(PathBuf::from)
                .filter(|p| p.is_dir());

            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
                cache_dir,
                root: Mutex::new(saved_root.clone()),
                generation: Arc::new(AtomicU64::new(0)),
            });

            // Re-scan the previously opened folder on launch, if any.
            if let Some(root) = saved_root {
                let state = app.state::<AppState>();
                start_indexing(&state, app.handle(), root);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_root,
            rescan,
            get_date_tree,
            list_assets,
            search_assets,
            get_thumb,
            reveal_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn mtime_of(p: &std::path::Path) -> i64 {
        std::fs::metadata(p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// End-to-end backend check: walk a real folder (AV_TEST_DIR), index it the
    /// same way the app does, and assert dates, aggregation and thumbnails.
    #[test]
    fn indexes_test_folder() {
        let dir = match std::env::var("AV_TEST_DIR") {
            Ok(d) if std::path::Path::new(&d).is_dir() => d,
            _ => {
                eprintln!("AV_TEST_DIR not set — skipping integration test");
                return;
            }
        };
        let root = PathBuf::from(&dir);

        let db_file = std::env::temp_dir().join("av-test-index.sqlite");
        let _ = std::fs::remove_file(&db_file);
        let conn = db::open(&db_file).expect("open db");

        // --- Walk + index (mirrors indexer::run's core) ---
        let mut count = 0;
        for entry in jwalk::WalkDir::new(&root).skip_hidden(true) {
            let entry = entry.unwrap();
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
            let mtime = mtime_of(&path);
            let cap = metadata::capture_info(&path, kind, mtime);
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            conn.execute(
                "INSERT INTO assets
                    (path,name,ext,kind,size,mtime,capture_ts,year,month,day,seen)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1)",
                rusqlite::params![
                    path.to_string_lossy(),
                    name,
                    ext,
                    kind,
                    entry.metadata().unwrap().len() as i64,
                    mtime,
                    cap.ts,
                    cap.year,
                    cap.month,
                    cap.day,
                ],
            )
            .unwrap();
            count += 1;
        }
        assert_eq!(count, 9, "expected 9 media files");

        // --- Aggregation via the real query used by the command ---
        let tree = query_date_tree(&conn, None, None).unwrap();
        assert_eq!(tree.total, 9, "tree total");

        let years: Vec<i32> = tree.years.iter().map(|y| y.year).collect();
        assert!(years.contains(&2024), "2024 present, got {years:?}");
        assert!(years.contains(&2023), "2023 present, got {years:?}");

        // Helper to fetch a kind count on a specific local date.
        let kind_count = |y: i32, m: u32, d: u32, k: &str| -> i64 {
            tree.years
                .iter()
                .find(|yn| yn.year == y)
                .and_then(|yn| yn.months.iter().find(|mn| mn.month == m))
                .and_then(|mn| mn.days.iter().find(|dn| dn.day == d))
                .and_then(|dn| dn.kinds.iter().find(|kc| kc.kind == k))
                .map(|kc| kc.count)
                .unwrap_or(0)
        };

        // These dates come from file mtimes (exact local time) so are stable.
        assert_eq!(kind_count(2024, 6, 15, "image"), 2, "two photos on 2024-06-15");
        assert_eq!(kind_count(2024, 6, 14, "image"), 1, "one photo on 2024-06-14");
        assert_eq!(kind_count(2023, 12, 25, "image"), 2, "two photos on 2023-12-25");
        assert_eq!(kind_count(2024, 6, 16, "audio"), 1, "audio on 2024-06-16");
        assert_eq!(kind_count(2024, 5, 20, "pdf"), 1, "pdf on 2024-05-20");

        // The two videos carry embedded creation_time in 2024 and 2023.
        let video_years: Vec<i32> = tree
            .years
            .iter()
            .filter(|yn| {
                yn.months.iter().any(|mn| {
                    mn.days
                        .iter()
                        .any(|dn| dn.kinds.iter().any(|kc| kc.kind == "video"))
                })
            })
            .map(|yn| yn.year)
            .collect();
        assert!(video_years.contains(&2024), "video in 2024 (mvhd parsed)");
        assert!(video_years.contains(&2023), "video in 2023 (mvhd parsed)");

        // --- Thumbnails for the visual kinds ---
        let cache = std::env::temp_dir().join("av-test-thumbs");
        let _ = std::fs::remove_dir_all(&cache);
        let mut thumbed = 0;
        for entry in jwalk::WalkDir::new(&root).skip_hidden(true) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            let kind = metadata::classify(&ext);
            if !matches!(kind, "image" | "video" | "pdf") {
                continue;
            }
            let mtime = mtime_of(&path);
            let thumb = thumbs::ensure(&cache, &path.to_string_lossy(), kind, mtime, 256);
            let thumb = thumb.unwrap_or_else(|| panic!("no thumbnail for {kind} {path:?}"));
            let len = std::fs::metadata(&thumb).unwrap().len();
            assert!(len > 0, "empty thumbnail for {path:?}");
            thumbed += 1;
        }
        assert_eq!(thumbed, 8, "8 image/video/pdf thumbnails");
        eprintln!("integration test OK: indexed {count}, thumbnailed {thumbed}");
    }
}
