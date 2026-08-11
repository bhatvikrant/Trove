use rusqlite::Connection;
use std::path::Path;

/// Open (creating if needed) the SQLite index and ensure the schema exists.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
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
    ] {
        let _ = conn.execute(stmt, []);
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
         CREATE INDEX IF NOT EXISTS idx_assets_camera ON assets(camera);
         CREATE INDEX IF NOT EXISTS idx_assets_place ON assets(place_country, place_city);",
    )?;
    Ok(conn)
}
