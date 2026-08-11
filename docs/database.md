# The index database

Trove keeps a single **SQLite** database as its working index. It's created and migrated
in `db.rs`, opened in [WAL mode](https://www.sqlite.org/wal.html) with a 10-second busy
timeout so the background indexer and the UI can read/write concurrently.

## Location

```
~/Library/Application Support/com.trove.app/
├── index.sqlite            # the index (+ -wal / -shm while running)
└── thumbnails/             # cached thumbnail / preview / face-crop JPEGs
```

The directory is derived from the app's bundle identifier (`com.trove.app`). Deleting
it is a full, safe reset — it never touches your actual media. Portable per-folder data lives
elsewhere (inside the media folder); see [portable-data.md](portable-data.md).

## Schema

### `assets` — one row per media file (the current folder)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `path` | TEXT UNIQUE | absolute path |
| `name`, `ext`, `kind` | TEXT | `kind` ∈ image/video/audio/pdf |
| `size`, `mtime` | INTEGER | bytes; modified time (fast-path + cache key) |
| `capture_ts` | INTEGER | resolved capture time (see [indexing.md](indexing.md)) |
| `year`, `month`, `day` | INTEGER | split out for cheap date-tree `GROUP BY` |
| `favorite` | INTEGER | 0/1 |
| `camera` | TEXT | EXIF make + model |
| `width`, `height` | INTEGER | pixels → orientation filter |
| `lat`, `lon` | REAL | EXIF GPS |
| `place_city`, `place_country` | TEXT | reverse-geocoded offline |
| `ocr` | TEXT | recognized text (feeds search) |
| `vision_done` | INTEGER | analysis gate; 0 = needs the Vision pass |
| `seen` | INTEGER | generation marker for the delete-unseen sweep |

Indexes on `capture_ts`, `(year,month,day)`, `name`, `favorite`, `camera`,
`(place_country, place_city)`.

### Analysis tables

| Table | Columns | Purpose |
| --- | --- | --- |
| `asset_labels` | `(asset_id, label)` | Vision scene/content labels (many per asset) |
| `faces` | `id, asset_id, x, y, w, h, embedding BLOB, cluster_id` | detected faces; box is normalized 0–1; embedding is a 768-float feature print (3072 bytes) |
| `people` | `(cluster_id, name)` | user-assigned name for a face cluster |

### Durable, path-keyed tables

These survive re-indexing and folder switches (unlike `assets`/`faces`, which are rebuilt),
and are the in-DB mirror of the portable sidecar:

| Table | Columns | Purpose |
| --- | --- | --- |
| `favorites` | `(path)` | favorites keyed by absolute path |
| `named_faces` | `(path, cx, cy, name)` | face names keyed by path + face centre |

### App state

| Table | Columns | Purpose |
| --- | --- | --- |
| `meta` | `(k, v)` | current `root`, `index_ver`, `vision_quality`, `sidecar_enabled` |
| `recents` | `(path, name, last_opened, count)` | welcome-screen recent folders |

## One folder at a time

The `assets`/`faces`/`asset_labels`/`people` tables hold the **currently open** folder.
Opening a different folder clears them and re-indexes. What makes favorites, names, and
analysis *survive* that (and travel to other machines) is the durable tables above plus the
[portable sidecar](portable-data.md) — the indexer re-seeds them by path on every open.

## The filter condition builder

Every browse query (tree, list, search, places, people) is scoped by the same `Filter`
struct via `filter_conditions()` in `main.rs`. It compiles a filter into SQL `AND`
conditions + bound params, so the date range, kinds, favorite, cameras, formats,
orientation, and scene labels all combine consistently. See
[filters-and-lenses.md](filters-and-lenses.md).

## Migrations

`db.rs` creates tables with `CREATE TABLE IF NOT EXISTS` and adds later columns with
idempotent `ALTER TABLE … ADD COLUMN` (duplicate-column errors are ignored). Content-level
re-derivation is handled separately by `INDEX_VER` (see [indexing.md](indexing.md)).
