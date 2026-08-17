use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::path::Path;

/// How long a connection waits for the write lock before giving up with
/// `SQLITE_BUSY` ("database is locked"). Generous, because it should only ever
/// be hit if a writer is genuinely stuck: writers are expected to hold the lock
/// for milliseconds (all file I/O happens outside their transactions).
pub const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Begin a write transaction, waiting for the lock if another connection holds
/// it. `BEGIN IMMEDIATE` takes the write lock up front, so the busy handler can
/// wait it out; a deferred transaction that reads first and writes later instead
/// fails immediately with `SQLITE_BUSY_SNAPSHOT` ("database is locked") when
/// another connection committed in between — a retry the busy handler never does
/// for us. Every multi-statement write should go through this.
pub fn write_tx(conn: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
}

/// Open (creating if needed) the SQLite index and ensure the schema exists.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // First, before any statement that can contend: setting `journal_mode` needs
    // a brief exclusive lock, and the schema setup below writes.
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS assets (
            id          INTEGER PRIMARY KEY,
            path        TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            ext         TEXT,
            kind        TEXT NOT NULL,
            size        INTEGER NOT NULL,
            mtime       INTEGER NOT NULL,
            capture_ts  INTEGER NOT NULL,
            year        INTEGER NOT NULL,
            month       INTEGER NOT NULL,
            day         INTEGER NOT NULL,
            seen        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_assets_capture ON assets(capture_ts);
        CREATE INDEX IF NOT EXISTS idx_assets_ymd ON assets(year, month, day);
        CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

        CREATE TABLE IF NOT EXISTS recents (
            path        TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            last_opened INTEGER NOT NULL,
            count       INTEGER
        );
        "#,
    )?;

    // Migrations: add columns to existing indexes (ignore "duplicate column").
    for stmt in [
        "ALTER TABLE assets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE assets ADD COLUMN camera TEXT",
        "ALTER TABLE assets ADD COLUMN width INTEGER",
        "ALTER TABLE assets ADD COLUMN height INTEGER",
        "ALTER TABLE assets ADD COLUMN lat REAL",
        "ALTER TABLE assets ADD COLUMN lon REAL",
        "ALTER TABLE assets ADD COLUMN place_city TEXT",
        "ALTER TABLE assets ADD COLUMN place_country TEXT",
        "ALTER TABLE assets ADD COLUMN ocr TEXT",
        "ALTER TABLE assets ADD COLUMN vision_done INTEGER NOT NULL DEFAULT 0",
        // How long the last completed analysis of this folder took, and when it
        // finished — so the app can still report it after a restart.
        "ALTER TABLE recents ADD COLUMN analysis_ms INTEGER",
        "ALTER TABLE recents ADD COLUMN analyzed_at INTEGER",
    ] {
        let _ = conn.execute(stmt, []);
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
         CREATE INDEX IF NOT EXISTS idx_assets_camera ON assets(camera);
         CREATE INDEX IF NOT EXISTS idx_assets_place ON assets(place_country, place_city);

         CREATE TABLE IF NOT EXISTS asset_labels (
            asset_id INTEGER NOT NULL,
            label    TEXT NOT NULL,
            PRIMARY KEY (asset_id, label)
         );
         CREATE INDEX IF NOT EXISTS idx_labels_label ON asset_labels(label);

         CREATE TABLE IF NOT EXISTS faces (
            id         INTEGER PRIMARY KEY,
            asset_id   INTEGER NOT NULL,
            x          REAL NOT NULL,
            y          REAL NOT NULL,
            w          REAL NOT NULL,
            h          REAL NOT NULL,
            embedding  BLOB,
            cluster_id INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_faces_asset ON faces(asset_id);
         CREATE INDEX IF NOT EXISTS idx_faces_cluster ON faces(cluster_id);

         CREATE TABLE IF NOT EXISTS people (
            cluster_id INTEGER PRIMARY KEY,
            name       TEXT
         );

         -- Durable, folder-independent state keyed by stable identifiers so it
         -- survives re-indexing / switching folders (unlike assets/faces/people,
         -- which are rebuilt per folder).
         CREATE TABLE IF NOT EXISTS favorites (
            path TEXT PRIMARY KEY
         );
         CREATE TABLE IF NOT EXISTS named_faces (
            path TEXT NOT NULL,
            cx   REAL NOT NULL,   -- face centre x (top-left origin, rounded)
            cy   REAL NOT NULL,   -- face centre y
            name TEXT NOT NULL,
            PRIMARY KEY (path, cx, cy)
         );
         CREATE INDEX IF NOT EXISTS idx_named_faces_path ON named_faces(path);

         -- Saved slideshow configurations (durable, folder-independent). The
         -- config is opaque JSON owned by the frontend.
         CREATE TABLE IF NOT EXISTS slideshow_presets (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            config     TEXT NOT NULL,
            created_at INTEGER NOT NULL
         );

         -- Saved special dates / occasions (recurring month+day), durable across
         -- folders. Used by the Occasions tab and slideshow.
         CREATE TABLE IF NOT EXISTS special_dates (
            id         INTEGER PRIMARY KEY,
            month      INTEGER NOT NULL,
            day        INTEGER NOT NULL,
            label      TEXT,
            created_at INTEGER NOT NULL
         );",
    )?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_db(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove_db_test_{}_{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("index.sqlite")
    }

    /// A second connection's write must wait for the current writer instead of
    /// failing with "database is locked" (SQLITE_BUSY).
    #[test]
    fn a_write_waits_for_the_current_writer() {
        let path = tmp_db("wait");
        let mut writer = open(&path).unwrap();
        let mut ui = open(&path).unwrap();

        let held = std::thread::spawn(move || {
            let tx = write_tx(&mut writer).unwrap();
            tx.execute("INSERT INTO meta(k,v) VALUES('a','1')", []).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
            tx.commit().unwrap();
        });
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Contends with the transaction above; must block, then succeed.
        let tx = write_tx(&mut ui).expect("write_tx blocked instead of erroring");
        tx.execute("DELETE FROM meta WHERE k='a'", []).unwrap();
        tx.commit().unwrap();
        held.join().unwrap();

        let rows: i64 = ui
            .query_row("SELECT COUNT(*) FROM meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "both writes applied, in order");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Why `write_tx` exists: a deferred transaction that reads before it writes
    /// gets SQLITE_BUSY the moment another connection commits in between, and the
    /// busy timeout does not help — the only fix is to write nothing beforehand
    /// or take the lock up front.
    #[test]
    fn deferred_read_then_write_fails_immediately() {
        let path = tmp_db("snapshot");
        let mut reader_writer = open(&path).unwrap();
        let other = open(&path).unwrap();

        let tx = reader_writer.transaction().unwrap(); // DEFERRED: snapshot on read
        let _: i64 = tx
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
            .unwrap();
        other
            .execute("INSERT INTO meta(k,v) VALUES('b','1')", [])
            .unwrap();

        let err = tx
            .execute("INSERT INTO meta(k,v) VALUES('c','1')", [])
            .expect_err("expected SQLITE_BUSY on the upgrade to a write");
        assert!(
            matches!(
                err.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy)
            ),
            "unexpected error: {err}"
        );
        drop(tx);

        // Same sequence via write_tx: the lock is taken before the read, so the
        // write can't be invalidated.
        let tx = write_tx(&mut reader_writer).unwrap();
        let _: i64 = tx
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
            .unwrap();
        tx.execute("INSERT INTO meta(k,v) VALUES('c','1')", [])
            .unwrap();
        tx.commit().unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
