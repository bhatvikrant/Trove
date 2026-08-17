export type Kind = "image" | "video" | "audio" | "pdf" | "other";

export interface Asset {
  id: number;
  path: string;
  name: string;
  ext: string | null;
  kind: Kind;
  size: number;
  mtime: number; // unix seconds
  captureTs: number; // unix seconds — the date used for grouping
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  favorite: boolean;
}

export type Orientation = "portrait" | "landscape" | "square";

/** A combinable set of constraints applied across every browse query. */
export interface AssetFilter {
  start: string | null; // inclusive date "YYYY-MM-DD"
  end: string | null;
  kinds: Kind[]; // empty = all
  favorite: boolean;
  cameras: string[];
  formats: string[]; // lowercase extensions
  orientation: Orientation | null;
  scenes: string[]; // Vision scene/content labels
}

export const EMPTY_FILTER: AssetFilter = {
  start: null,
  end: null,
  kinds: [],
  favorite: false,
  cameras: [],
  formats: [],
  orientation: null,
  scenes: [],
};

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facets {
  cameras: FacetValue[];
  formats: FacetValue[];
  scenes: FacetValue[];
}

export type VisionQuality = "accurate" | "fast";

export interface Settings {
  visionQuality: VisionQuality;
  storeInFolder: boolean;
}

/** One place Trove keeps data on disk. */
export interface DataLocation {
  path: string;
  /** `path` with the user's home collapsed to `~`, for display. */
  display: string;
  /** False for a sidecar not written yet — the path still says where it'd go. */
  exists: boolean;
}

/** Where the open folder's Trove data lives, inside it and on this Mac. */
export interface DataLocations {
  folder: DataLocation | null;
  app: DataLocation;
}

export type Lens = "date" | "places" | "people" | "occasions";

export interface PlaceCity {
  city: string;
  count: number;
  lat: number;
  lon: number;
}

export interface PlaceCountry {
  country: string;
  code: string | null; // ISO alpha-2, for the flag emoji
  count: number;
  cities: PlaceCity[];
}

export interface Places {
  total: number;
  noLocation: number;
  countries: PlaceCountry[];
}

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Person {
  clusterId: number;
  name: string | null;
  count: number;
  path: string; // representative asset
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface KindCount {
  kind: Kind;
  count: number;
}

export interface DayNode {
  day: number;
  count: number;
  kinds: KindCount[];
}

export interface MonthNode {
  month: number;
  count: number;
  days: DayNode[];
}

export interface YearNode {
  year: number;
  count: number;
  months: MonthNode[];
}

export interface DateTree {
  total: number;
  years: YearNode[];
}

export interface IndexProgress {
  /** Identifies the analysis run these numbers belong to. */
  runId: number;
  /** The folder being indexed — not necessarily the one on screen. */
  root: string;
  /** How long the run has been going, measured by the backend. */
  elapsedMs: number;
  scanned: number;
  indexed: number;
  total: number | null;
  done: boolean;
  currentPath?: string;
}

export interface VisionProgress {
  runId: number;
  root: string;
  elapsedMs: number;
  processed: number;
  total: number;
  done: boolean;
}

/**
 * The indexing run in flight, as the backend sees it. Indexing outlives the
 * screen that started it, so the UI asks for this on mount rather than relying
 * on having heard the events.
 */
export interface IndexStatus {
  runId: number;
  root: string;
  elapsedMs: number;
  /** Walking + reading metadata, then the photo-analysis pass. */
  phase: "indexing" | "analyzing";
  scanned: number;
  indexed: number;
  total: number | null;
  processed: number;
  visionTotal: number;
}

/** The `index-cancelled` event: a run stopped before it finished. */
export interface IndexCancelled {
  runId: number;
  root: string;
}

/** A finished analysis run: indexing + photo analysis, end to end. */
export interface AnalysisRun {
  durationMs: number;
  finishedAt: number; // unix seconds
}

/** The `analysis-done` event: a run that just ended. */
export interface AnalysisDone extends AnalysisRun {
  runId: number;
  root: string;
}

// Inclusive date range in local time. `null` means unbounded on that side.
export interface DateRange {
  start: string | null; // ISO date "YYYY-MM-DD"
  end: string | null; // ISO date "YYYY-MM-DD"
}

export interface RecentFolder {
  path: string;
  name: string;
  lastOpened: number; // unix seconds
  count: number | null; // assets indexed last time, if known
  exists: boolean;
}

export interface QuickLocation {
  label: string;
  path: string;
  kind: string; // pictures | desktop | downloads | movies | drive
}

export interface QuickLocations {
  standard: QuickLocation[];
  drives: QuickLocation[];
}

// ---------- Slideshow ----------

/** A recurring calendar day (month+day, any year), e.g. a birthday. */
export interface SpecialDate {
  month: number; // 1-12
  day: number; // 1-31
  label?: string;
}

/** Everything needed to resolve and play a slideshow. Serialized into presets. */
export interface SlideshowConfig {
  kinds: Kind[]; // empty = all
  favoriteOnly: boolean;
  specialDates: SpecialDate[]; // empty = all dates
  windowDays: number; // ± days around each special date
  personClusterIds: number[]; // any-of; empty = anyone
  // Playback
  durationSec: number;
  shuffle: boolean;
  loop: boolean;
  crossfade: boolean;
  kenBurns: boolean;
  captions: boolean;
  muteVideo: boolean;
}

export const DEFAULT_SLIDESHOW_CONFIG: SlideshowConfig = {
  kinds: ["image", "video"],
  favoriteOnly: false,
  specialDates: [],
  windowDays: 0,
  personClusterIds: [],
  durationSec: 5,
  shuffle: true,
  loop: true,
  crossfade: true,
  kenBurns: true,
  captions: true,
  muteVideo: true,
};

/** An asset resolved for the slideshow, with caption extras. */
export interface SlideshowItem extends Asset {
  people: string[];
  place: string | null;
}

export interface SlideshowPreset {
  id: number;
  name: string;
  config: string; // serialized SlideshowConfig
  createdAt: number;
}

/** A persisted occasion (recurring month+day) with its asset count. */
export interface SavedSpecialDate {
  id: number;
  month: number;
  day: number;
  label: string | null;
  count: number;
}
