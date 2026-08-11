// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod indexer;
mod metadata;
mod places;
mod thumbs;
mod vision;

use chrono::{Duration, Local, NaiveDate, TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};

struct AppState {
    db: Mutex<Connection>,
    db_path: PathBuf,
    cache_dir: PathBuf,
    root: Mutex<Option<PathBuf>>,
    generation: Arc<AtomicU64>,
    vision_helper: Option<PathBuf>,
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
    favorite: bool,
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

/// A combinable set of constraints applied across every browse query.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Filter {
    start: Option<String>, // inclusive date "YYYY-MM-DD"
    end: Option<String>,
    kinds: Option<Vec<String>>,
    favorite: Option<bool>,
    cameras: Option<Vec<String>>,
    formats: Option<Vec<String>>, // lowercase extensions
    orientation: Option<String>,  // portrait | landscape | square
    scenes: Option<Vec<String>>,  // Vision scene/content labels
}

fn day_start_unix(s: &str) -> Option<i64> {
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    Local
        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .map(|dt| dt.timestamp())
}

fn day_end_unix(s: &str) -> Option<i64> {
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()? + Duration::days(1);
    Local
        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .map(|dt| dt.timestamp())
}

type Bind = Box<dyn rusqlite::types::ToSql>;

/// Build SQL conditions + bound params for a filter (all combined with AND).
fn filter_conditions(f: &Option<Filter>) -> (Vec<String>, Vec<Bind>) {
    let mut conds: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    let Some(f) = f else {
        return (conds, binds);
    };
    if let Some(lo) = f.start.as_deref().and_then(day_start_unix) {
        conds.push("capture_ts >= ?".into());
        binds.push(Box::new(lo));
    }
    if let Some(hi) = f.end.as_deref().and_then(day_end_unix) {
        conds.push("capture_ts < ?".into());
        binds.push(Box::new(hi));
    }
    let in_clause = |col: &str, vals: &[String], conds: &mut Vec<String>, binds: &mut Vec<Bind>| {
        if !vals.is_empty() {
            let ph = vals.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            conds.push(format!("{col} IN ({ph})"));
            for v in vals {
                binds.push(Box::new(v.clone()));
            }
        }
    };
    if let Some(kinds) = &f.kinds {
        in_clause("kind", kinds, &mut conds, &mut binds);
    }
    if let Some(cameras) = &f.cameras {
        in_clause("camera", cameras, &mut conds, &mut binds);
    }
    if let Some(formats) = &f.formats {
        in_clause("ext", formats, &mut conds, &mut binds);
    }
    if f.favorite == Some(true) {
        conds.push("favorite = 1".into());
    }
    match f.orientation.as_deref() {
        Some("portrait") => conds.push("(width > 0 AND height > 0 AND height > width)".into()),
        Some("landscape") => conds.push("(width > 0 AND height > 0 AND width > height)".into()),
        Some("square") => conds.push("(width > 0 AND height > 0 AND width = height)".into()),
        _ => {}
    }
    if let Some(scenes) = &f.scenes {
        if !scenes.is_empty() {
            let ph = scenes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            conds.push(format!(
                "id IN (SELECT asset_id FROM asset_labels WHERE label IN ({ph}))"
            ));
            for s in scenes {
                binds.push(Box::new(s.clone()));
            }
        }
    }
    (conds, binds)
}

fn where_clause(conds: &[String]) -> String {
    if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    }
}

fn start_indexing(state: &AppState, app: &tauri::AppHandle, root: PathBuf) {
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    indexer::spawn(
        app.clone(),
        state.db_path.clone(),
        root,
        state.generation.clone(),
        my_gen,
        state.vision_helper.clone(),
    );
}

#[tauri::command]
fn set_root(
    path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Accept a dropped file too — open its containing folder.
    let mut root = PathBuf::from(&path);
    if !root.is_dir() {
        if root.is_file() {
            root = root
                .parent()
                .map(|p| p.to_path_buf())
                .ok_or("File has no parent folder")?;
        } else {
            return Err(format!("Not a folder: {path}"));
        }
    }
    let root_str = root.to_string_lossy().to_string();
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&root_str)
        .to_string();
    let now = now_unix();
    {
        let conn = state.db.lock().unwrap();
        // The per-folder index is rebuilt from scratch. Favorites and face
        // names live in the durable `favorites` / `named_faces` tables (keyed
        // by path), so they survive this and get reattached on re-index.
        conn.execute_batch(
            "DELETE FROM assets;
             DELETE FROM faces;
             DELETE FROM asset_labels;
             DELETE FROM people;",
        )
        .map_err(e2s)?;
        conn.execute(
            "INSERT INTO meta(k,v) VALUES('root',?1)
             ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            [&root_str],
        )
        .map_err(e2s)?;
        conn.execute(
            "INSERT INTO recents(path,name,last_opened,count) VALUES(?1,?2,?3,NULL)
             ON CONFLICT(path) DO UPDATE SET name=excluded.name, last_opened=excluded.last_opened",
            rusqlite::params![root_str, name, now],
        )
        .map_err(e2s)?;
    }
    *state.root.lock().unwrap() = Some(root.clone());
    start_indexing(&state, &app, root);
    Ok(root_str)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentFolder {
    path: String,
    name: String,
    last_opened: i64,
    count: Option<i64>,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickLocation {
    label: String,
    path: String,
    kind: String,
}

#[derive(Serialize)]
struct QuickLocations {
    standard: Vec<QuickLocation>,
    drives: Vec<QuickLocation>,
}

#[tauri::command]
fn get_recent_folders(state: State<AppState>) -> Result<Vec<RecentFolder>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT path, name, last_opened, count FROM recents \
             ORDER BY last_opened DESC LIMIT 12",
        )
        .map_err(e2s)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(e2s)?;
    let mut out = Vec::new();
    for row in rows {
        let (path, name, last_opened, count) = row.map_err(e2s)?;
        let exists = std::path::Path::new(&path).is_dir();
        out.push(RecentFolder {
            path,
            name,
            last_opened,
            count,
            exists,
        });
    }
    Ok(out)
}

#[tauri::command]
fn remove_recent(path: String, state: State<AppState>) -> Result<(), String> {
    state
        .db
        .lock()
        .unwrap()
        .execute("DELETE FROM recents WHERE path=?1", [&path])
        .map_err(e2s)?;
    Ok(())
}

#[tauri::command]
fn get_quick_locations() -> Result<QuickLocations, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut standard = Vec::new();
    for (label, sub, kind) in [
        ("Pictures", "Pictures", "pictures"),
        ("Desktop", "Desktop", "desktop"),
        ("Downloads", "Downloads", "downloads"),
        ("Movies", "Movies", "movies"),
    ] {
        let p = format!("{home}/{sub}");
        if std::path::Path::new(&p).is_dir() {
            standard.push(QuickLocation {
                label: label.into(),
                path: p,
                kind: kind.into(),
            });
        }
    }

    let mut drives = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                drives.push(QuickLocation {
                    label: e.file_name().to_string_lossy().to_string(),
                    path: p.to_string_lossy().to_string(),
                    kind: "drive".into(),
                });
            }
        }
    }
    drives.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(QuickLocations { standard, drives })
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
fn get_date_tree(filter: Option<Filter>, state: State<AppState>) -> Result<DateTree, String> {
    let (conds, binds) = filter_conditions(&filter);
    let conn = state.db.lock().unwrap();
    let params: Vec<&dyn rusqlite::types::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    aggregate_tree(&conn, &where_clause(&conds), &params).map_err(e2s)
}

/// Test helper: aggregate with just an optional date range.
#[cfg(test)]
fn query_date_tree(
    conn: &Connection,
    lo: Option<i64>,
    hi: Option<i64>,
) -> rusqlite::Result<DateTree> {
    let mut conds: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    if let Some(lo) = lo {
        conds.push("capture_ts >= ?".into());
        binds.push(Box::new(lo));
    }
    if let Some(hi) = hi {
        conds.push("capture_ts < ?".into());
        binds.push(Box::new(hi));
    }
    let params: Vec<&dyn rusqlite::types::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    aggregate_tree(conn, &where_clause(&conds), &params)
}

fn aggregate_tree(
    conn: &Connection,
    where_sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> rusqlite::Result<DateTree> {
    let sql = format!(
        "SELECT year, month, day, kind, COUNT(*) FROM assets{} \
         GROUP BY year, month, day, kind \
         ORDER BY year DESC, month DESC, day DESC, kind ASC",
        where_sql
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params, |r| {
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
        favorite: r.get::<_, i64>(11)? != 0,
    })
}

const ASSET_COLS: &str =
    "id, path, name, ext, kind, size, mtime, capture_ts, year, month, day, favorite";

fn run_asset_query(
    conn: &Connection,
    sql: &str,
    binds: &[Bind],
) -> Result<Vec<Asset>, String> {
    let params: Vec<&dyn rusqlite::types::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(sql).map_err(e2s)?;
    let rows = stmt
        .query_map(params.as_slice(), map_asset)
        .map_err(e2s)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(e2s)?);
    }
    Ok(out)
}

#[tauri::command]
fn list_assets(
    year: i32,
    month: u32,
    day: u32,
    kind: Option<String>,
    filter: Option<Filter>,
    state: State<AppState>,
) -> Result<Vec<Asset>, String> {
    let (mut conds, mut binds) = filter_conditions(&filter);
    conds.insert(0, "year = ?".into());
    conds.insert(1, "month = ?".into());
    conds.insert(2, "day = ?".into());
    binds.insert(0, Box::new(year as i64));
    binds.insert(1, Box::new(month as i64));
    binds.insert(2, Box::new(day as i64));
    if let Some(k) = kind {
        conds.push("kind = ?".into());
        binds.push(Box::new(k));
    }
    let sql = format!(
        "SELECT {ASSET_COLS} FROM assets{} ORDER BY capture_ts ASC, name COLLATE NOCASE ASC",
        where_clause(&conds)
    );
    let conn = state.db.lock().unwrap();
    run_asset_query(&conn, &sql, &binds)
}

#[tauri::command]
fn search_assets(
    query: String,
    filter: Option<Filter>,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<Asset>, String> {
    let (mut conds, mut binds) = filter_conditions(&filter);
    let like = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
    // Match the file name or any recognized text in the image (OCR).
    conds.insert(0, "(name LIKE ? ESCAPE '\\' OR ocr LIKE ? ESCAPE '\\')".into());
    binds.insert(0, Box::new(like.clone()));
    binds.insert(1, Box::new(like));
    let sql = format!(
        "SELECT {ASSET_COLS} FROM assets{} ORDER BY capture_ts DESC LIMIT ?",
        where_clause(&conds)
    );
    binds.push(Box::new(limit));
    let conn = state.db.lock().unwrap();
    run_asset_query(&conn, &sql, &binds)
}

#[derive(Serialize)]
struct FacetValue {
    value: String,
    count: i64,
}

#[derive(Serialize)]
struct Facets {
    cameras: Vec<FacetValue>,
    formats: Vec<FacetValue>,
    scenes: Vec<FacetValue>,
}

fn query_facet(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<FacetValue>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(FacetValue {
            value: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    rows.collect()
}

#[tauri::command]
fn get_facets(state: State<AppState>) -> Result<Facets, String> {
    let conn = state.db.lock().unwrap();
    let cameras = query_facet(
        &conn,
        "SELECT camera, COUNT(*) FROM assets \
         WHERE camera IS NOT NULL AND camera <> '' \
         GROUP BY camera ORDER BY COUNT(*) DESC, camera ASC",
    )
    .map_err(e2s)?;
    let formats = query_facet(
        &conn,
        "SELECT ext, COUNT(*) FROM assets \
         WHERE ext IS NOT NULL AND ext <> '' \
         GROUP BY ext ORDER BY COUNT(*) DESC, ext ASC",
    )
    .map_err(e2s)?;
    let scenes = query_facet(
        &conn,
        "SELECT label, COUNT(*) FROM asset_labels \
         GROUP BY label ORDER BY COUNT(*) DESC, label ASC LIMIT 60",
    )
    .map_err(e2s)?;
    Ok(Facets {
        cameras,
        formats,
        scenes,
    })
}

#[tauri::command]
fn set_favorite(id: i64, favorite: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE assets SET favorite = ?1 WHERE id = ?2",
        rusqlite::params![favorite as i64, id],
    )
    .map_err(e2s)?;
    // Mirror into the durable, path-keyed favorites table so the choice
    // survives re-indexing / switching folders.
    if favorite {
        conn.execute(
            "INSERT OR IGNORE INTO favorites(path) SELECT path FROM assets WHERE id=?1",
            [id],
        )
        .map_err(e2s)?;
    } else {
        conn.execute(
            "DELETE FROM favorites WHERE path = (SELECT path FROM assets WHERE id=?1)",
            [id],
        )
        .map_err(e2s)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    vision_quality: String, // "accurate" | "fast"
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    let conn = state.db.lock().unwrap();
    let vision_quality = conn
        .query_row("SELECT v FROM meta WHERE k='vision_quality'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_else(|_| "accurate".into());
    Ok(Settings { vision_quality })
}

/// Change the analysis (OCR) quality and re-analyze photos with the new setting.
#[tauri::command]
fn set_vision_quality(
    quality: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let q = if quality == "fast" { "fast" } else { "accurate" };
    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO meta(k,v) VALUES('vision_quality',?1)
             ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            [q],
        )
        .map_err(e2s)?;
        // Re-run analysis for all images under the new quality.
        conn.execute("UPDATE assets SET vision_done=0 WHERE kind='image'", [])
            .map_err(e2s)?;
    }
    let root = state.root.lock().unwrap().clone();
    if let Some(r) = root {
        start_indexing(&state, &app, r);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceCity {
    city: String,
    count: i64,
    lat: f64,
    lon: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceCountry {
    country: String,
    count: i64,
    cities: Vec<PlaceCity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Places {
    total: i64,
    no_location: i64,
    countries: Vec<PlaceCountry>,
}

/// Aggregated country → city counts (with representative coordinates for map
/// pins), plus the count of assets with no location — within the filter.
#[tauri::command]
fn get_places(filter: Option<Filter>, state: State<AppState>) -> Result<Places, String> {
    let (conds, binds) = filter_conditions(&filter);
    let params: Vec<&dyn rusqlite::types::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let conn = state.db.lock().unwrap();

    let mut located = conds.clone();
    located.push("place_country IS NOT NULL".into());
    let sql = format!(
        "SELECT place_country, place_city, COUNT(*), AVG(lat), AVG(lon) FROM assets{} \
         GROUP BY place_country, place_city \
         ORDER BY place_country ASC, COUNT(*) DESC",
        where_clause(&located)
    );
    let mut stmt = conn.prepare(&sql).map_err(e2s)?;
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<f64>>(3)?,
                r.get::<_, Option<f64>>(4)?,
            ))
        })
        .map_err(e2s)?;

    let mut countries: Vec<PlaceCountry> = Vec::new();
    let mut located_total = 0i64;
    for row in rows {
        let (country, city, cnt, lat, lon) = row.map_err(e2s)?;
        located_total += cnt;
        if countries.last().map(|c| c.country.as_str()) != Some(country.as_str()) {
            countries.push(PlaceCountry {
                country: country.clone(),
                count: 0,
                cities: Vec::new(),
            });
        }
        let c = countries.last_mut().unwrap();
        c.count += cnt;
        c.cities.push(PlaceCity {
            city: city.unwrap_or_else(|| "Unknown".into()),
            count: cnt,
            lat: lat.unwrap_or(0.0),
            lon: lon.unwrap_or(0.0),
        });
    }

    let mut nl = conds.clone();
    nl.push("place_country IS NULL".into());
    let nl_sql = format!("SELECT COUNT(*) FROM assets{}", where_clause(&nl));
    let no_location: i64 = conn
        .query_row(&nl_sql, params.as_slice(), |r| r.get(0))
        .map_err(e2s)?;

    Ok(Places {
        total: located_total + no_location,
        no_location,
        countries,
    })
}

/// Assets at a place. `country = None` means the "no location" bucket; with a
/// country and no city, all assets in that country.
#[tauri::command]
fn list_place_assets(
    country: Option<String>,
    city: Option<String>,
    filter: Option<Filter>,
    state: State<AppState>,
) -> Result<Vec<Asset>, String> {
    let (mut conds, mut binds) = filter_conditions(&filter);
    match country {
        None => conds.push("place_country IS NULL".into()),
        Some(c) => {
            conds.push("place_country = ?".into());
            binds.push(Box::new(c));
            if let Some(ci) = city {
                conds.push("place_city = ?".into());
                binds.push(Box::new(ci));
            }
        }
    }
    let sql = format!(
        "SELECT {ASSET_COLS} FROM assets{} ORDER BY capture_ts ASC, name COLLATE NOCASE ASC",
        where_clause(&conds)
    );
    let conn = state.db.lock().unwrap();
    run_asset_query(&conn, &sql, &binds)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    cluster_id: i64,
    name: Option<String>,
    count: i64,
    path: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Clustered people (≥2 faces) within the filter, each with a representative
/// face (largest) for a thumbnail. Best-effort recognition.
#[tauri::command]
fn get_people(filter: Option<Filter>, state: State<AppState>) -> Result<Vec<Person>, String> {
    let (conds, binds) = filter_conditions(&filter);
    let params: Vec<&dyn rusqlite::types::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "WITH filtered AS (SELECT id FROM assets{}), \
         ranked AS ( \
           SELECT f.cluster_id AS cid, a.path AS path, f.x AS x, f.y AS y, f.w AS w, f.h AS h, \
             ROW_NUMBER() OVER (PARTITION BY f.cluster_id ORDER BY f.w*f.h DESC) AS rn, \
             COUNT(*) OVER (PARTITION BY f.cluster_id) AS cnt \
           FROM faces f JOIN assets a ON a.id = f.asset_id \
           WHERE f.cluster_id IS NOT NULL AND f.asset_id IN (SELECT id FROM filtered) \
         ) \
         SELECT r.cid, r.cnt, r.path, r.x, r.y, r.w, r.h, p.name \
         FROM ranked r LEFT JOIN people p ON p.cluster_id = r.cid \
         WHERE r.rn = 1 AND r.cnt >= 2 \
         ORDER BY r.cnt DESC, r.cid ASC",
        where_clause(&conds)
    );
    let mut stmt = conn.prepare(&sql).map_err(e2s)?;
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            Ok(Person {
                cluster_id: r.get(0)?,
                count: r.get(1)?,
                path: r.get(2)?,
                x: r.get(3)?,
                y: r.get(4)?,
                w: r.get(5)?,
                h: r.get(6)?,
                name: r.get(7)?,
            })
        })
        .map_err(e2s)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(e2s)?);
    }
    Ok(out)
}

#[tauri::command]
fn list_person_assets(
    cluster_id: i64,
    filter: Option<Filter>,
    state: State<AppState>,
) -> Result<Vec<Asset>, String> {
    let (mut conds, mut binds) = filter_conditions(&filter);
    conds.push("id IN (SELECT asset_id FROM faces WHERE cluster_id = ?)".into());
    binds.push(Box::new(cluster_id));
    let sql = format!(
        "SELECT {ASSET_COLS} FROM assets{} ORDER BY capture_ts ASC, name COLLATE NOCASE ASC",
        where_clause(&conds)
    );
    let conn = state.db.lock().unwrap();
    run_asset_query(&conn, &sql, &binds)
}

/// Persist a cluster's current name into the durable, path-keyed `named_faces`
/// table so it can be reattached after the folder is re-indexed (which assigns
/// fresh cluster ids). Keyed by file path + face centre. A cleared name removes
/// the durable entries for that cluster's faces.
fn record_cluster_label(conn: &rusqlite::Connection, cluster_id: i64) -> rusqlite::Result<()> {
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM people WHERE cluster_id=?1",
            [cluster_id],
            |r| r.get(0),
        )
        .unwrap_or(None);
    // Drop any prior labels for this cluster's faces first.
    conn.execute(
        "DELETE FROM named_faces WHERE (path, cx, cy) IN (
            SELECT a.path, ROUND(f.x + f.w/2.0, 3), ROUND(f.y + f.h/2.0, 3)
            FROM faces f JOIN assets a ON a.id = f.asset_id
            WHERE f.cluster_id = ?1
         )",
        [cluster_id],
    )?;
    if let Some(n) = name {
        conn.execute(
            "INSERT OR REPLACE INTO named_faces(path, cx, cy, name)
             SELECT a.path, ROUND(f.x + f.w/2.0, 3), ROUND(f.y + f.h/2.0, 3), ?2
             FROM faces f JOIN assets a ON a.id = f.asset_id
             WHERE f.cluster_id = ?1",
            rusqlite::params![cluster_id, n],
        )?;
    }
    Ok(())
}

/// Merge one person cluster into another (user confirms they're the same
/// person). Faces move to `target`; `source` is removed. Keeps `target`'s name,
/// falling back to `source`'s if target has none.
#[tauri::command]
fn merge_people(source: i64, target: i64, state: State<AppState>) -> Result<(), String> {
    if source == target {
        return Ok(());
    }
    let conn = state.db.lock().unwrap();
    let target_name: Option<String> = conn
        .query_row("SELECT name FROM people WHERE cluster_id=?1", [target], |r| {
            r.get(0)
        })
        .unwrap_or(None);
    if target_name.is_none() {
        let source_name: Option<String> = conn
            .query_row("SELECT name FROM people WHERE cluster_id=?1", [source], |r| {
                r.get(0)
            })
            .unwrap_or(None);
        if let Some(n) = source_name {
            conn.execute(
                "INSERT INTO people(cluster_id, name) VALUES(?1, ?2)
                 ON CONFLICT(cluster_id) DO UPDATE SET name=excluded.name",
                rusqlite::params![target, n],
            )
            .map_err(e2s)?;
        }
    }
    conn.execute(
        "UPDATE faces SET cluster_id=?1 WHERE cluster_id=?2",
        rusqlite::params![target, source],
    )
    .map_err(e2s)?;
    conn.execute("DELETE FROM people WHERE cluster_id=?1", [source])
        .map_err(e2s)?;
    // The source's durable labels (path-keyed) now belong to the target.
    record_cluster_label(&conn, target).map_err(e2s)?;
    Ok(())
}

#[tauri::command]
fn rename_person(cluster_id: i64, name: String, state: State<AppState>) -> Result<(), String> {
    let name = name.trim();
    let value: Option<&str> = if name.is_empty() { None } else { Some(name) };
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO people(cluster_id, name) VALUES(?1, ?2)
         ON CONFLICT(cluster_id) DO UPDATE SET name = excluded.name",
        rusqlite::params![cluster_id, value],
    )
    .map_err(e2s)?;
    // Persist by face position so the name survives re-indexing.
    record_cluster_label(&conn, cluster_id).map_err(e2s)?;
    Ok(())
}

#[tauri::command]
fn get_face_thumb(
    path: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    size: u32,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let thumb = thumbs::face_thumb(&state.cache_dir, &path, mtime, (x, y, w, h), size.clamp(48, 512));
    Ok(thumb.map(|p| p.to_string_lossy().to_string()))
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

/// A cached, screen-sized preview for an image (so we don't decode the full
/// multi-megapixel/HEIC original on every step). Returns None for non-images —
/// the frontend renders those (video/pdf/audio) natively from the original.
#[tauri::command]
fn get_preview(path: String, state: State<AppState>) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if metadata::classify(&ext) != "image" {
        return Ok(None);
    }
    let mtime = std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let preview = thumbs::ensure(&state.cache_dir, &path, "image", mtime, 2560);
    Ok(preview.map(|p| p.to_string_lossy().to_string()))
}

/// Rename an asset on disk (within its folder) and update the index. Returns the
/// updated row so the UI can refresh the selection.
#[tauri::command]
fn rename_asset(path: String, name: String, state: State<AppState>) -> Result<Asset, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name can’t be empty".into());
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Name can’t contain slashes".into());
    }
    let old = std::path::Path::new(&path);
    let parent = old.parent().ok_or("File has no parent folder")?;
    let new_path = parent.join(name);
    let new_path_str = new_path.to_string_lossy().to_string();

    if new_path_str != path && new_path.exists() {
        // Allow case-only renames on case-insensitive filesystems.
        let same = matches!(
            (new_path.canonicalize(), old.canonicalize()),
            (Ok(a), Ok(b)) if a == b
        );
        if !same {
            return Err(format!("“{name}” already exists in this folder"));
        }
    }

    std::fs::rename(old, &new_path).map_err(e2s)?;
    let ext = new_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());

    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE assets SET path=?1, name=?2, ext=?3 WHERE path=?4",
        rusqlite::params![new_path_str, name, ext, path],
    )
    .map_err(e2s)?;
    conn.query_row(
        &format!("SELECT {ASSET_COLS} FROM assets WHERE path=?1"),
        [&new_path_str],
        map_asset,
    )
    .map_err(e2s)
}

/// Move an asset to the system Trash (reversible) and drop it from the index.
#[tauri::command]
fn delete_asset(path: String, state: State<AppState>) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())?;
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM assets WHERE path=?1", [&path])
        .map_err(e2s)?;
    Ok(())
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

            // Application menu with a File ▸ Open Folder… (⌘O) item, plus the
            // standard Edit menu so clipboard shortcuts work in text inputs.
            let open_item = MenuItem::with_id(
                app,
                "open-folder",
                "Open Folder…",
                true,
                Some("CmdOrCtrl+O"),
            )?;
            let settings_item = MenuItem::with_id(
                app,
                "settings",
                "Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            let app_menu = Submenu::with_items(
                app,
                "App",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings_item,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let file_menu = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &open_item,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])?;
            app.set_menu(menu)?;

            let conn = db::open(&db_path).expect("failed to open index db");
            let saved_root: Option<PathBuf> = conn
                .query_row("SELECT v FROM meta WHERE k='root'", [], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
                .map(PathBuf::from)
                .filter(|p| p.is_dir());

            // Locate the Vision helper: bundled resource (release) or the dev
            // build output. Absent → scene/OCR enrichment is simply skipped.
            let vision_helper = app
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join("bin/vision-helper"))
                .filter(|p| p.exists())
                .or_else(|| {
                    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin/vision-helper");
                    dev.exists().then_some(dev)
                });

            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
                cache_dir,
                root: Mutex::new(saved_root.clone()),
                generation: Arc::new(AtomicU64::new(0)),
                vision_helper,
            });

            // Re-scan the previously opened folder on launch, if any.
            if let Some(root) = saved_root {
                let state = app.state::<AppState>();
                start_indexing(&state, app.handle(), root);
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-folder" => {
                let _ = app.emit("menu-open-folder", ());
            }
            "settings" => {
                let _ = app.emit("menu-settings", ());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            set_root,
            rescan,
            get_date_tree,
            list_assets,
            search_assets,
            get_thumb,
            get_preview,
            rename_asset,
            delete_asset,
            reveal_in_finder,
            get_recent_folders,
            remove_recent,
            get_quick_locations,
            get_facets,
            set_favorite,
            get_places,
            list_place_assets,
            get_settings,
            set_vision_quality,
            get_people,
            list_person_assets,
            rename_person,
            merge_people,
            get_face_thumb,
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
            let ts = match kind {
                "image" => metadata::extract_exif(&path).datetime.unwrap_or(mtime),
                "video" => metadata::mp4_creation(&path).unwrap_or(mtime),
                _ => mtime,
            };
            let (year, month, day) = metadata::ymd(ts, mtime);
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
                    ts,
                    year,
                    month,
                    day,
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
