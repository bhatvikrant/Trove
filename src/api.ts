import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Asset,
  AssetFilter,
  DateTree,
  Facets,
  IndexProgress,
  Kind,
  Person,
  Places,
  QuickLocations,
  RecentFolder,
  Settings,
  SavedSpecialDate,
  SlideshowConfig,
  SlideshowItem,
  SlideshowPreset,
  SpecialDate,
  VisionProgress,
  VisionQuality,
} from "./types";

/** Prompt the user to choose a folder to index. Returns null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a folder of assets",
  });
  if (Array.isArray(selected)) return selected[0] ?? null;
  return selected ?? null;
}

/**
 * Point the indexer at a root folder (a dropped file resolves to its folder).
 * Kicks off a background scan and returns the resolved folder path.
 */
export async function setRoot(path: string): Promise<string> {
  return invoke("set_root", { path });
}

/** Recently opened folders, most recent first. */
export async function getRecentFolders(): Promise<RecentFolder[]> {
  return invoke("get_recent_folders");
}

/** Remove a folder from the recents list. */
export async function removeRecent(path: string): Promise<void> {
  await invoke("remove_recent", { path });
}

/** Standard folders (Pictures, Desktop, …) and mounted volumes. */
export async function getQuickLocations(): Promise<QuickLocations> {
  return invoke("get_quick_locations");
}

/** Subscribe to the File ▸ Open Folder (⌘O) menu action. */
export async function onMenuOpenFolder(cb: () => void): Promise<UnlistenFn> {
  return listen("menu-open-folder", () => cb());
}

/** Subscribe to the Settings… (⌘,) menu action. */
export async function onMenuSettings(cb: () => void): Promise<UnlistenFn> {
  return listen("menu-settings", () => cb());
}

/** Read app settings. */
export async function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

/** Set analysis (OCR) quality; re-analyzes photos in the background. */
export async function setVisionQuality(quality: VisionQuality): Promise<void> {
  await invoke("set_vision_quality", { quality });
}

/** Toggle writing the portable `.trove` sidecar into the open folder. */
export async function setStoreInFolder(enabled: boolean): Promise<void> {
  await invoke("set_store_in_folder", { enabled });
}

/** Re-scan the current root for new/changed/removed files. */
export async function rescan(): Promise<void> {
  await invoke("rescan");
}

/**
 * Reset all Trove-specific data for the open folder: delete its portable
 * `.trove` sidecar, drop this folder's favorites and face names, and re-index
 * from scratch. The media files themselves are untouched.
 */
export async function resetFolder(): Promise<void> {
  await invoke("reset_folder");
}

/** A single Trove feature whose data can be reset independently. */
export type ResettableFeature =
  | "faces"
  | "favorites"
  | "occasions"
  | "slideshows"
  | "recents";

/** Reset one feature's data (e.g. clear all face names), leaving the rest. */
export async function resetFeature(feature: ResettableFeature): Promise<void> {
  await invoke("reset_feature", { feature });
}

/**
 * Reset app-wide settings and data to defaults: preferences, recents, saved
 * slideshows, and occasions, and close the current folder. Media files and any
 * in-folder `.trove` data are untouched.
 */
export async function resetApp(): Promise<void> {
  await invoke("reset_app");
}

/** Aggregated year→month→day→kind counts, within the active filter. */
export async function getDateTree(filter?: AssetFilter): Promise<DateTree> {
  return invoke("get_date_tree", { filter: filter ?? null });
}

/** The individual assets for a given day + kind (kind optional = all kinds). */
export async function listAssets(params: {
  year: number;
  month: number;
  day: number;
  kind?: Kind | null;
  filter?: AssetFilter;
}): Promise<Asset[]> {
  return invoke("list_assets", {
    year: params.year,
    month: params.month,
    day: params.day,
    kind: params.kind ?? null,
    filter: params.filter ?? null,
  });
}

/** Distinct camera and format facet values with counts. */
export async function getFacets(): Promise<Facets> {
  return invoke("get_facets");
}

/** Star / unstar an asset. */
export async function setFavorite(id: number, favorite: boolean): Promise<void> {
  await invoke("set_favorite", { id, favorite });
}

/** Aggregated country → city counts (+ coordinates) within the filter. */
export async function getPlaces(filter?: AssetFilter): Promise<Places> {
  return invoke("get_places", { filter: filter ?? null });
}

/** Assets at a place; country=null is the "no location" bucket. */
export async function listPlaceAssets(params: {
  country: string | null;
  city?: string | null;
  filter?: AssetFilter;
}): Promise<Asset[]> {
  return invoke("list_place_assets", {
    country: params.country,
    city: params.city ?? null,
    filter: params.filter ?? null,
  });
}

/** Clustered people (with a representative face) within the filter. */
export async function getPeople(filter?: AssetFilter): Promise<Person[]> {
  return invoke("get_people", { filter: filter ?? null });
}

/** Assets containing a given person (face cluster). */
export async function listPersonAssets(params: {
  clusterId: number;
  filter?: AssetFilter;
}): Promise<Asset[]> {
  return invoke("list_person_assets", {
    clusterId: params.clusterId,
    filter: params.filter ?? null,
  });
}

/** Name (or clear the name of) a person cluster. */
export async function renamePerson(clusterId: number, name: string): Promise<void> {
  await invoke("rename_person", { clusterId, name });
}

/** Merge one person cluster into another (they're the same person). */
export async function mergePeople(source: number, target: number): Promise<void> {
  await invoke("merge_people", { source, target });
}

/** A webview-loadable URL for a square face crop. */
export async function getFaceThumb(
  path: string,
  box: { x: number; y: number; w: number; h: number },
  size = 96
): Promise<string | null> {
  const p = await invoke<string | null>("get_face_thumb", {
    path,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    size,
  });
  return p ? convertFileSrc(p) : null;
}

/** Full-index name search, constrained to the active filter. */
export async function searchAssets(
  query: string,
  filter?: AssetFilter,
  limit = 500
): Promise<Asset[]> {
  return invoke("search_assets", { query, filter: filter ?? null, limit });
}

/**
 * Ensure a cached thumbnail exists for `path`, returning a webview-loadable URL
 * (or null if a thumbnail could not be produced for this file type).
 */
export async function getThumb(
  path: string,
  size = 256
): Promise<string | null> {
  const thumbPath = await invoke<string | null>("get_thumb", { path, size });
  return thumbPath ? convertFileSrc(thumbPath) : null;
}

/** A webview-loadable URL for the original asset (for the full preview pane). */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/**
 * A webview-loadable URL for a cached, screen-sized preview of an image, so the
 * pane doesn't decode the full original on every step. Returns null for
 * non-images (render those from the original) or if a preview can't be made.
 */
export async function getPreview(path: string): Promise<string | null> {
  const previewPath = await invoke<string | null>("get_preview", { path });
  return previewPath ? convertFileSrc(previewPath) : null;
}

/** Rename an asset on disk (within its folder). Returns the updated row. */
export async function renameAsset(path: string, name: string): Promise<Asset> {
  return invoke("rename_asset", { path, name });
}

/** Move an asset to the system Trash (reversible) and drop it from the index. */
export async function deleteAsset(path: string): Promise<void> {
  await invoke("delete_asset", { path });
}

/** Reveal a file in Finder. */
export async function revealInFinder(path: string): Promise<void> {
  await invoke("reveal_in_finder", { path });
}

// ---------- Slideshow ----------

/**
 * Expand recurring special dates (+ a ± day window) into the concrete
 * (month, day) pairs the backend matches. Uses a leap year so Feb 29 works and
 * window arithmetic crosses month boundaries correctly; deduplicated.
 */
export function expandMonthDays(
  dates: SpecialDate[],
  windowDays: number
): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const d of dates) {
    for (let k = -windowDays; k <= windowDays; k++) {
      const dt = new Date(2020, d.month - 1, d.day);
      dt.setDate(dt.getDate() + k);
      const m = dt.getMonth() + 1;
      const day = dt.getDate();
      const key = `${m}-${day}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([m, day]);
      }
    }
  }
  return out;
}

function configToQuery(cfg: SlideshowConfig) {
  return {
    kinds: cfg.kinds,
    favoriteOnly: cfg.favoriteOnly,
    monthDays: expandMonthDays(cfg.specialDates, cfg.windowDays),
    personClusterIds: cfg.personClusterIds,
    order: cfg.shuffle ? "shuffle" : "chronological",
    limit: 5000,
  };
}

/** Resolve the assets for a slideshow config (with caption extras). */
export async function listSlideshowAssets(
  cfg: SlideshowConfig
): Promise<SlideshowItem[]> {
  return invoke("list_slideshow_assets", { query: configToQuery(cfg) });
}

/** Count assets matching a slideshow config (for the live indicator). */
export async function countSlideshowAssets(
  cfg: SlideshowConfig
): Promise<number> {
  return invoke("count_slideshow_assets", { query: configToQuery(cfg) });
}

/** Saved slideshow presets, newest first. */
export async function listSlideshowPresets(): Promise<SlideshowPreset[]> {
  return invoke("list_slideshow_presets");
}

/** Persist the current slideshow config under a name. */
export async function saveSlideshowPreset(
  name: string,
  config: SlideshowConfig
): Promise<SlideshowPreset> {
  return invoke("save_slideshow_preset", {
    name,
    config: JSON.stringify(config),
  });
}

/** Delete a saved slideshow preset. */
export async function deleteSlideshowPreset(id: number): Promise<void> {
  await invoke("delete_slideshow_preset", { id });
}

/** Saved occasions (recurring dates), each with its asset count. */
export async function listSpecialDates(): Promise<SavedSpecialDate[]> {
  return invoke("list_special_dates");
}

/** Persist a new occasion. */
export async function addSpecialDate(
  month: number,
  day: number,
  label: string | null
): Promise<SavedSpecialDate> {
  return invoke("add_special_date", { month, day, label });
}

/** Delete a saved occasion. */
export async function deleteSpecialDate(id: number): Promise<void> {
  await invoke("delete_special_date", { id });
}

/** Subscribe to indexing progress. Returns an unlisten function. */
export async function onIndexProgress(
  cb: (p: IndexProgress) => void
): Promise<UnlistenFn> {
  return listen<IndexProgress>("index-progress", (e) => cb(e.payload));
}

/** Subscribe to Vision (scene/OCR) enrichment progress. */
export async function onVisionProgress(
  cb: (p: VisionProgress) => void
): Promise<UnlistenFn> {
  return listen<VisionProgress>("vision-progress", (e) => cb(e.payload));
}
