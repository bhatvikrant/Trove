//! Portable, per-folder metadata stored *inside* the media folder, so a folder
//! carries its favorites, face names, and analysis cache to any Mac.
//!
//! Files under `<root>/.trove/`:
//!   - `curation.json` — favorites + face names (small, plain text, atomic
//!     write; the irreplaceable user intent, kept human-readable and separate
//!     so a damaged analysis cache never risks it).
//!   - `analysis.db` — a compact SQLite cache of derived analysis (scene labels,
//!     OCR text, and faces incl. box + cluster + embedding). Lets a folder skip
//!     re-analysis on any machine; only new/changed media is analyzed.
//!
//! Everything is keyed by the asset's path **relative to the folder root**, so
//! it stays valid when the folder moves or is opened on another computer. A
//! cached record is only reused when the file's `size` and `mtime` still match.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// Distinguishes concurrent atomic writes so overlapping favorite toggles don't
// share (and clobber) one temp file before the rename.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn dir(root: &Path) -> PathBuf {
    root.join(".trove")
}
fn curation_file(root: &Path) -> PathBuf {
    dir(root).join("curation.json")
}
fn analysis_file(root: &Path) -> PathBuf {
    dir(root).join("analysis.db")
}

/// Absolute path under `root` -> portable '/'-separated relative path. `None`
/// when `abs` is not actually under `root`.
fn rel(root: &Path, abs: &str) -> Option<String> {
    let stripped = Path::new(abs).strip_prefix(root).ok()?;
    let s = stripped.to_string_lossy().replace('\\', "/");
    (!s.is_empty()).then_some(s)
}
fn abs(root: &Path, rel: &str) -> String {
    root.join(rel).to_string_lossy().to_string()
}

fn io_err<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

/// Whether Trove is allowed to *write* its sidecar into the folder. Reading an
/// existing sidecar is always fine; this only gates creating/updating it.
pub fn enabled(conn: &Connection) -> bool {
    conn.query_row("SELECT v FROM meta WHERE k='sidecar_enabled'", [], |r| {
        r.get::<_, String>(0)
    })
    .map(|v| v != "0")
    .unwrap_or(true)
}

// ----------------------------- curation.json -----------------------------

#[derive(Serialize, Deserialize, Default)]
struct Curation {
    version: u32,
    #[serde(default)]
    favorites: Vec<String>,
    #[serde(default)]
    names: Vec<NamedFace>,
}

#[derive(Serialize, Deserialize)]
struct NamedFace {
    path: String,
    cx: f64,
    cy: f64,
    name: String,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), seq));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Merge an existing `curation.json` into the central durable tables (as
/// absolute paths). Missing/unreadable/malformed file is a silent no-op.
pub fn import_curation(conn: &Connection, root: &Path) {
    let Ok(text) = std::fs::read_to_string(curation_file(root)) else {
        return;
    };
    let Ok(cur) = serde_json::from_str::<Curation>(&text) else {
        return;
    };
    for relp in &cur.favorites {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO favorites(path) VALUES(?1)",
            [abs(root, relp)],
        );
    }
    for nf in &cur.names {
        if nf.name.trim().is_empty() {
            continue;
        }
        let _ = conn.execute(
            "INSERT OR REPLACE INTO named_faces(path,cx,cy,name) VALUES(?1,?2,?3,?4)",
            rusqlite::params![abs(root, &nf.path), nf.cx, nf.cy, nf.name],
        );
    }
}

/// Rewrite `curation.json` from the central tables, keeping only entries that
/// live under `root`. Best-effort: a read-only folder just fails quietly.
pub fn export_curation(conn: &Connection, root: &Path) -> std::io::Result<()> {
    let mut cur = Curation {
        version: 1,
        favorites: Vec::new(),
        names: Vec::new(),
    };
    {
        let mut stmt = conn.prepare("SELECT path FROM favorites").map_err(io_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(io_err)?;
        for p in rows.flatten() {
            if let Some(rp) = rel(root, &p) {
                cur.favorites.push(rp);
            }
        }
    }
    {
        let mut stmt = conn
            .prepare("SELECT path,cx,cy,name FROM named_faces")
            .map_err(io_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(io_err)?;
        for (p, cx, cy, name) in rows.flatten() {
            if let Some(rp) = rel(root, &p) {
                cur.names.push(NamedFace {
                    path: rp,
                    cx,
                    cy,
                    name,
                });
            }
        }
    }
    cur.favorites.sort();
    cur.names.sort_by(|a, b| a.path.cmp(&b.path));
    let bytes = serde_json::to_vec_pretty(&cur).map_err(io_err)?;
    write_atomic(&curation_file(root), &bytes)
}

// ------------------------------ analysis.db ------------------------------

/// Open the analysis cache. `create=false` returns `None` if it doesn't exist.
/// Uses rollback-journal mode (no `-wal`/`-shm` sidecars) so the cache is a
/// single self-contained file that copies/syncs cleanly.
fn open_analysis(root: &Path, create: bool) -> Option<Connection> {
    let file = analysis_file(root);
    if !create && !file.exists() {
        return None;
    }
    if create {
        std::fs::create_dir_all(dir(root)).ok()?;
    }
    let conn = Connection::open(&file).ok()?;
    let _ = conn.pragma_update(None, "journal_mode", "DELETE");
    let _ = conn.busy_timeout(Duration::from_secs(10));
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS a (
            path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, ocr TEXT
         );
         CREATE TABLE IF NOT EXISTS a_labels (path TEXT, label TEXT);
         CREATE TABLE IF NOT EXISTS a_faces (
            path TEXT, x REAL, y REAL, w REAL, h REAL, cluster INTEGER, embedding BLOB
         );
         CREATE INDEX IF NOT EXISTS idx_a_labels ON a_labels(path);
         CREATE INDEX IF NOT EXISTS idx_a_faces ON a_faces(path);",
    )
    .ok()?;
    Some(conn)
}

/// Restore cached analysis for assets whose file is unchanged (`size`+`mtime`
/// match), marking them `vision_done` so the Vision pass skips them. Returns the
/// number of assets restored. Only touches `vision_done=0` image rows.
pub fn restore_analysis(central: &mut Connection, root: &Path) -> usize {
    let Some(side) = open_analysis(root, false) else {
        return 0;
    };
    let candidates: Vec<(i64, String, i64, i64)> = {
        let Ok(mut stmt) = central
            .prepare("SELECT id,path,size,mtime FROM assets WHERE kind='image' AND vision_done=0")
        else {
            return 0;
        };
        let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        }) else {
            return 0;
        };
        rows.flatten().collect()
    };
    if candidates.is_empty() {
        return 0;
    }

    let Ok(tx) = central.transaction() else {
        return 0;
    };
    let mut restored = 0usize;
    for (id, path, size, mtime) in candidates {
        let Some(relp) = rel(root, &path) else { continue };
        let hit: Option<(i64, i64, Option<String>)> = side
            .query_row("SELECT size,mtime,ocr FROM a WHERE path=?1", [&relp], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .ok();
        let Some((ssize, smtime, socr)) = hit else {
            continue;
        };
        if ssize != size || smtime != mtime {
            continue; // file changed since it was analyzed -> re-analyze it
        }
        let labels: Vec<String> = side
            .prepare("SELECT label FROM a_labels WHERE path=?1")
            .and_then(|mut st| {
                st.query_map([&relp], |r| r.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();
        let faces: Vec<(f64, f64, f64, f64, Option<i64>, Vec<u8>)> = side
            .prepare("SELECT x,y,w,h,cluster,embedding FROM a_faces WHERE path=?1")
            .and_then(|mut st| {
                st.query_map([&relp], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();

        let _ = tx.execute(
            "UPDATE assets SET ocr=?1, vision_done=1 WHERE id=?2",
            rusqlite::params![socr, id],
        );
        let _ = tx.execute("DELETE FROM asset_labels WHERE asset_id=?1", [id]);
        let _ = tx.execute("DELETE FROM faces WHERE asset_id=?1", [id]);
        for l in &labels {
            let _ = tx.execute(
                "INSERT OR IGNORE INTO asset_labels(asset_id,label) VALUES(?1,?2)",
                rusqlite::params![id, l],
            );
        }
        for (x, y, w, h, cluster, emb) in &faces {
            let _ = tx.execute(
                "INSERT INTO faces(asset_id,x,y,w,h,embedding,cluster_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                rusqlite::params![id, x, y, w, h, emb, cluster],
            );
        }
        restored += 1;
    }
    let _ = tx.commit();
    restored
}

/// Write the current analysis for every analyzed asset into the sidecar (full
/// rebuild, so deleted media is pruned). Best-effort: silently does nothing if
/// the folder can't be written.
pub fn export_analysis(central: &Connection, root: &Path) {
    let Some(mut side) = open_analysis(root, true) else {
        return;
    };
    let assets: Vec<(i64, String, i64, i64, Option<String>)> = {
        let Ok(mut stmt) =
            central.prepare("SELECT id,path,size,mtime,ocr FROM assets WHERE vision_done=1")
        else {
            return;
        };
        let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        }) else {
            return;
        };
        rows.flatten().collect()
    };

    // Read labels/faces per asset up front, then write in one transaction.
    let Ok(tx) = side.transaction() else { return };
    if tx
        .execute_batch("DELETE FROM a; DELETE FROM a_labels; DELETE FROM a_faces;")
        .is_err()
    {
        return;
    }
    for (id, path, size, mtime, ocr) in &assets {
        let Some(relp) = rel(root, path) else { continue };
        let _ = tx.execute(
            "INSERT OR REPLACE INTO a(path,size,mtime,ocr) VALUES(?1,?2,?3,?4)",
            rusqlite::params![relp, size, mtime, ocr],
        );
        let labels: Vec<String> = central
            .prepare("SELECT label FROM asset_labels WHERE asset_id=?1")
            .and_then(|mut st| {
                st.query_map([id], |r| r.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();
        for l in labels {
            let _ = tx.execute(
                "INSERT INTO a_labels(path,label) VALUES(?1,?2)",
                rusqlite::params![relp, l],
            );
        }
        let faces: Vec<(f64, f64, f64, f64, Option<i64>, Vec<u8>)> = central
            .prepare("SELECT x,y,w,h,cluster_id,embedding FROM faces WHERE asset_id=?1")
            .and_then(|mut st| {
                st.query_map([id], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();
        for (x, y, w, h, cluster, emb) in faces {
            let _ = tx.execute(
                "INSERT INTO a_faces(path,x,y,w,h,cluster,embedding) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                rusqlite::params![relp, x, y, w, h, cluster, emb],
            );
        }
    }
    let _ = tx.commit();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn insert_asset(conn: &Connection, path: &str, mtime: i64, vision_done: i64, ocr: &str) -> i64 {
        conn.execute(
            "INSERT INTO assets(path,name,kind,size,mtime,capture_ts,year,month,day,vision_done,ocr)
             VALUES(?1,'x','image',100,?2,0,2020,1,1,?3,?4)",
            rusqlite::params![path, mtime, vision_done, ocr],
        )
        .unwrap();
        conn.query_row("SELECT id FROM assets WHERE path=?1", [path], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn export_then_restore_on_fresh_machine() {
        let tmp = std::env::temp_dir().join(format!("trove_sidecar_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("media");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("sub/a.jpg");
        let fpath = file.to_string_lossy().to_string();

        // ---- Machine A: index with analysis, a favorite, and a named face.
        let conn_a = db::open(&tmp.join("a.sqlite")).unwrap();
        let id = insert_asset(&conn_a, &fpath, 1000, 1, "hello world");
        conn_a
            .execute("INSERT INTO asset_labels(asset_id,label) VALUES(?1,'beach')", [id])
            .unwrap();
        conn_a
            .execute(
                "INSERT INTO faces(asset_id,x,y,w,h,embedding,cluster_id) VALUES(?1,0.1,0.2,0.3,0.4,?2,7)",
                rusqlite::params![id, vec![9u8, 8, 7, 6]],
            )
            .unwrap();
        conn_a
            .execute("INSERT INTO favorites(path) VALUES(?1)", [&fpath])
            .unwrap();
        conn_a
            .execute(
                "INSERT INTO named_faces(path,cx,cy,name) VALUES(?1,0.25,0.4,'Ana')",
                [&fpath],
            )
            .unwrap();

        export_curation(&conn_a, &root).unwrap();
        export_analysis(&conn_a, &root);
        assert!(curation_file(&root).exists());
        assert!(analysis_file(&root).exists());

        // ---- Machine B: fresh DB; folder copied so the file is at the same
        // relative path (fresh id, favorite=0, vision_done=0).
        let mut conn_b = db::open(&tmp.join("b.sqlite")).unwrap();
        import_curation(&conn_b, &root);
        insert_asset(&conn_b, &fpath, 1000, 0, "");
        conn_b
            .execute(
                "UPDATE assets SET favorite=1 WHERE path IN (SELECT path FROM favorites)",
                [],
            )
            .unwrap();
        assert_eq!(restore_analysis(&mut conn_b, &root), 1);

        let (fav, done, ocr): (i64, i64, String) = conn_b
            .query_row(
                "SELECT favorite,vision_done,ocr FROM assets WHERE path=?1",
                [&fpath],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(fav, 1, "favorite restored by relative path");
        assert_eq!(done, 1, "marked analyzed so Vision skips it");
        assert_eq!(ocr, "hello world");
        let cluster: i64 = conn_b
            .query_row("SELECT cluster_id FROM faces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cluster, 7, "face + cluster restored");
        let labels: i64 = conn_b
            .query_row("SELECT COUNT(*) FROM asset_labels", [], |r| r.get(0))
            .unwrap();
        assert_eq!(labels, 1);
        let named: i64 = conn_b
            .query_row("SELECT COUNT(*) FROM named_faces WHERE name='Ana'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(named, 1, "name imported from curation.json");

        // A changed file (different mtime) must NOT be restored -> re-analyzed.
        conn_b
            .execute("UPDATE assets SET vision_done=0, mtime=2000", [])
            .unwrap();
        conn_b.execute("DELETE FROM faces", []).unwrap();
        assert_eq!(restore_analysis(&mut conn_b, &root), 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
