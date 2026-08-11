import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Asset, DateRange, DateTree, IndexProgress, Kind } from "./types";

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

/** Point the indexer at a root folder. Kicks off a background scan. */
export async function setRoot(path: string): Promise<void> {
  await invoke("set_root", { path });
}

/** Re-scan the current root for new/changed/removed files. */
export async function rescan(): Promise<void> {
  await invoke("rescan");
}

/** Aggregated year→month→day→kind counts, optionally within a date range. */
export async function getDateTree(range?: DateRange): Promise<DateTree> {
  return invoke("get_date_tree", { range: range ?? null });
}

/** The individual assets for a given day + kind (kind optional = all kinds). */
export async function listAssets(params: {
  year: number;
  month: number;
  day: number;
  kind?: Kind | null;
  range?: DateRange;
}): Promise<Asset[]> {
  return invoke("list_assets", {
    year: params.year,
    month: params.month,
    day: params.day,
    kind: params.kind ?? null,
    range: params.range ?? null,
  });
}

/** Full-index name search, optionally constrained to a date range. */
export async function searchAssets(
  query: string,
  range?: DateRange,
  limit = 500
): Promise<Asset[]> {
  return invoke("search_assets", { query, range: range ?? null, limit });
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
