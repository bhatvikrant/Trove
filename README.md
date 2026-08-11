# Trove

Trove is a fast, native macOS desktop app for browsing local media — photos, videos, audio and PDFs — organized by the date they were captured. Point it at any folder (a local directory or a connected SSD) and it indexes everything recursively into a date tree.

Built with **Tauri v2** (Rust) + **React/TypeScript**. Uses macOS's native WebKit, so **HEIC photos and HEVC/`.mov` videos render natively** without conversion.

## Features

- **Date tree** — year → month → day → kind (Photos / Videos / Audio / PDFs), newest first. Fully virtualized, so tens of thousands of items scroll smoothly.
- **Capture-accurate dates** — reads EXIF `DateTimeOriginal` for photos and the `moov/mvhd` creation time for `.mp4`/`.mov`, falling back to the file's modified time otherwise.
- **Calendar range picker** with smart presets (Today, Yesterday, Last 7/30 days, This/Last month, This/Last year, All time) plus a two-month range calendar.
- **Combinable filters** — a Filters popover and an active-filter chip bar for media type, favorites, camera, format, and orientation; all combine (AND) with the date range and apply across the tree, lists, and search. A sidebar lens switcher (Date, with Places/People coming) frames the browse dimension.
- **Favorites** — star any asset from the preview pane and filter to just your starred ones.
- **Preview pane** — native rendering for images, video (with controls), audio, and PDFs.
- **Name search** across the whole index, respecting the active date range.
- **Background indexing** with a local **SQLite** cache and a disk **thumbnail cache** (via `sips` / `ffmpeg` / QuickLook), so re-opening is instant.
- **Welcome screen** — when no folder is open: recent folders (with asset counts), quick access to Pictures/Desktop/Downloads/Movies and connected drives, drag-and-drop a folder onto the window, and `⌘O` / a File ▸ Open Folder menu item.
- Reveal any asset in Finder.
- **Rename** — double-click an asset's name (in the tree or the preview info bar) to edit it inline; Enter/blur commits, Esc cancels.
- **Delete** — a Delete button in the preview pane moves the file to the **Trash** (reversible) after a confirmation prompt.
- **Keyboard navigation** in the tree — `↑`/`↓` move, `→` expands (or steps into children), `←` collapses (or hops to the parent), `Enter`/`Space` opens, `Home`/`End` jump to the first/last row. Arrowing onto an asset previews it live.
- **Search shortcuts** — `/` or `⌘F` focuses search; `↓`/`Enter` dives from the search box into the tree; `Esc` clears the query (then blurs to the tree). Everything in the sidebar is reachable by `Tab` with visible focus rings.
- **Preview navigation** — focus the preview pane (`Tab` to it or click it) and use `←`/`→` (or `↑`/`↓`) to cycle to the asset before/after the current one, wrapping around. On-screen `‹ ›` buttons and an "n of total" indicator appear too. Cycling follows the same order shown in the tree.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable)
- `ffmpeg` on your `PATH` (for video thumbnails): `brew install ffmpeg`
  - `sips` and `qlmanage` ship with macOS.

## Develop

```bash
npm install
npm run app      # tauri dev — launches the app with hot reload
```

## Build a distributable

```bash
npm run app:build   # produces a .app and .dmg under src-tauri/target/release/bundle
```

## How it works

| Layer | Location | Role |
| --- | --- | --- |
| UI | `src/` | React components: navbar, calendar, virtualized date tree, preview pane |
| Indexer | `src-tauri/src/indexer.rs` | Recursive walk, batched upserts, progress events, incremental re-scan |
| Metadata | `src-tauri/src/metadata.rs` | EXIF + MP4/MOV atom parsing for capture dates |
| Thumbnails | `src-tauri/src/thumbs.rs` | `sips` (images/HEIC), `ffmpeg` (video), QuickLook (PDF) → cached JPEGs |
| Index DB | `src-tauri/src/db.rs` | SQLite schema + queries |

The index and thumbnail cache live in `~/Library/Application Support/com.assetsviewer.app/`.

Thumbnails are keyed by file path + modified time, so editing or replacing a file regenerates its thumbnail automatically. Re-scanning removes entries for files that no longer exist.

## Tests

```bash
# Backend integration test (indexing, date extraction, aggregation, thumbnails).
# Point it at a folder of sample media:
cd src-tauri
AV_TEST_DIR=/path/to/some/media cargo test -- --nocapture
```
