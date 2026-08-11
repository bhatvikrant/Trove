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
  Places,
  QuickLocations,
  RecentFolder,
  VisionProgress,
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

/** Re-scan the current root for new/changed/removed files. */
export async function rescan(): Promise<void> {
  await invoke("rescan");
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
