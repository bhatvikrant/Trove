# Contributing & development

Thanks for hacking on Trove! This guide covers setup, the project layout, and the common
extension points.

## Prerequisites

- **macOS** (Trove uses native Vision, `sips`, `qlmanage`, and WebKit — it's macOS-only)
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable)
- **Xcode Command Line Tools** — provides `swiftc` to compile the Vision helper
  (`xcode-select --install`). Without it the app still builds; scene/OCR/faces are disabled.
- **ffmpeg** on `PATH` for video thumbnails: `brew install ffmpeg`

## Run & build

```bash
npm install
npm run app        # tauri dev — the full app with hot reload
npm run app:build  # produces a .app and .dmg under src-tauri/target/release/bundle
```

Frontend-only scripts (rarely needed directly): `npm run dev` (Vite), `npm run build`
(typecheck + bundle).

## Tests

```bash
cd src-tauri
cargo test                          # unit + integration tests (incl. the sidecar round-trip)
AV_TEST_DIR=/path/to/media cargo test -- --nocapture   # exercise indexing against real files
```

Always run `cargo test` and `npx tsc --noEmit` before opening a PR.

## Project layout

```
src/                      React + TypeScript UI
  api.ts                  typed invoke() wrappers — the only IPC surface
  types.ts                shared TS types
  components/             tree, preview, lenses, filters, settings, …
  worldLand.ts            generated offline world-map path (see scripts/gen-world.mjs)
src-tauri/src/            Rust core
  main.rs                 AppState, native menu, all #[tauri::command] handlers
  db.rs                   SQLite schema + migrations
  indexer.rs              walk, upsert, incremental re-scan, Vision enrichment, clustering
  metadata.rs             file classification + capture-date extraction
  vision.rs               talks to the Swift Vision helper (batch protocol)
  places.rs               offline reverse-geocoding
  thumbs.rs               thumbnail / preview / face-crop generation + cache
  sidecar.rs              the portable .trove folder
src-tauri/vision/         vision-helper.swift (compiled by build.rs)
scripts/                  gen-world.mjs, gen-icon.mjs
docs/                     these documents
```

See [architecture.md](architecture.md) for how the pieces fit together.

## Common extension points

### Add a backend command

1. Write the handler in `main.rs`:
   ```rust
   #[tauri::command]
   fn my_command(arg: String, state: State<AppState>) -> Result<Something, String> { … }
   ```
2. Register it in the `tauri::generate_handler![ … ]` list.
3. Add a typed wrapper in `src/api.ts` and any shared types in `src/types.ts`.

Arguments and returned structs use `#[serde(rename_all = "camelCase")]` so Rust
`snake_case` fields map to TS `camelCase`.

### Add a filter facet

Extend the `Filter` struct and `filter_conditions()` in `main.rs` (and, if it's a
user-visible choice, `get_facets` + `FiltersMenu.tsx`). One condition builder scopes every
query, so a new facet applies everywhere at once. See
[filters-and-lenses.md](filters-and-lenses.md).

### Work on UI in a browser

The UI degrades gracefully without the Rust backend (IPC calls reject and are caught), so
for pure layout/styling work you can run `npm run dev` and open the Vite URL in a normal
browser to iterate quickly — then verify in `npm run app`.

## Conventions

- **Comments explain _why_,** not _what_. Match the density and voice of the surrounding
  code.
- **Keep the IPC surface in `api.ts`.** Components don't call `invoke()` directly.
- **Derived data is disposable.** Thumbnails, embeddings, and the analysis cache can always
  be regenerated — never put irreplaceable user intent only in a cache.
- **Prefer the standard toolchain.** New dependencies should earn their place.

## Topic docs

| Topic | Doc |
| --- | --- |
| Big picture, process model, IPC catalog | [architecture.md](architecture.md) |
| Indexing pipeline & capture dates | [indexing.md](indexing.md) |
| SQLite schema reference | [database.md](database.md) |
| Vision: scenes, OCR, people | [analysis.md](analysis.md) |
| Portable `.trove` sidecar | [portable-data.md](portable-data.md) |
| Lenses, filters, places | [filters-and-lenses.md](filters-and-lenses.md) |
| Thumbnails & previews | [thumbnails.md](thumbnails.md) |
