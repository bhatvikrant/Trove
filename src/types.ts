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

export type Lens = "date" | "places" | "people";

export interface PlaceCity {
  city: string;
  count: number;
  lat: number;
  lon: number;
}

export interface PlaceCountry {
  country: string;
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
  scanned: number;
  indexed: number;
  total: number | null;
  done: boolean;
  currentPath?: string;
}

export interface VisionProgress {
  processed: number;
  total: number;
  done: boolean;
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
