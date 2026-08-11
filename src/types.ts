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
