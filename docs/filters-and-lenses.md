# Lenses, filters & places

Trove browses the same filtered set of assets through three **lenses**, and narrows that set
with a combinable **filter**. The lens is *how* you browse; the filter is *what's in scope*.

## Lenses

A sidebar lens switcher (`LensSwitcher.tsx`) frames the browse dimension. All three respect
the active filter.

| Lens | Left pane | Right pane | Backed by |
| --- | --- | --- | --- |
| **Date** | virtualized year→month→day→kind tree | preview | `get_date_tree`, `list_assets` |
| **Places** | country → city tree | offline world map with clustered pins | `get_places`, `list_place_assets` |
| **People** | people list | face grid | `get_people`, `list_person_assets` |

## The filter

One `Filter` struct (`main.rs`) drives every query. `filter_conditions()` compiles it into
SQL `AND` conditions + bound params, so a single code path scopes the tree, lists, search,
places, and people identically.

| Facet | Field | How it's matched |
| --- | --- | --- |
| Date range | `start` / `end` | `capture_ts` between local day bounds |
| Media type | `kinds` | `kind IN (…)` |
| Favorites | `favorite` | `favorite = 1` |
| Camera | `cameras` | `camera IN (…)` (EXIF make+model) |
| Format | `formats` | `ext IN (…)` |
| Orientation | `orientation` | portrait/landscape/square from `width`/`height` |
| Scene | `scenes` | `id IN (SELECT asset_id FROM asset_labels WHERE label IN (…))` |

Everything combines with `AND`. The UI presents it as:

- a **calendar range picker** with smart presets (Today, Yesterday, Last 7/30 days,
  This/Last month, This/Last year, All time) plus a two-month range calendar;
- a **Filters popover** (`FiltersMenu.tsx`) whose choices come from `get_facets` (distinct
  cameras, formats, and Vision scene labels in the current folder);
- an **active-filter chip bar** (`FilterChips.tsx`) to see and clear what's applied.

## Places — offline geocoding

Photos with EXIF GPS are reverse-geocoded entirely **offline** in `places.rs` using
[`reverse_geocoder`](https://docs.rs/reverse_geocoder) (a bundled nearest-city dataset) plus
[`isocountry`](https://docs.rs/isocountry) to turn a country code into a name. Results are
cached in `assets.place_city` / `place_country`, so geocoding runs once per photo.

`get_places` rolls those up into Country → City counts with representative coordinates; the
right pane renders them on an offline SVG world map.

### The map

The map isn't a tile service — it's a single self-contained SVG path generated from
[Natural Earth](https://www.naturalearthdata.com/) 50m country outlines by
`scripts/gen-world.mjs` into `src/worldLand.ts`, projected equirectangularly
(`x = lon + 180`, `y = 90 − lat`). `PlacesMap.tsx` adds pointer-based pan/zoom, marker-icon
pins sized by count, and a hover tooltip. Fully offline, no external requests.

## Search

Search (`search_assets`) matches the query against **file names and OCR text**
(`assets.ocr`, populated by the [Vision pass](analysis.md)), constrained to the active
filter — so a word from a screenshot or document finds the photo, within whatever date
range and facets you've set.
