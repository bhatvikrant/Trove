import type { IndexProgress, VisionProgress } from "../types";

interface Props {
  indexing: boolean;
  progress: IndexProgress | null;
  /** Indexing completion 0–100, or null while the total is still unknown. */
  progressPct: number | null;
  vision: VisionProgress | null;
  /** Assets currently in view (respecting the active filter). */
  total: number;
}

/**
 * Persistent bottom status bar. Shows indexing / analysis activity (with a thin
 * progress line) while work is in flight, and an idle asset count otherwise.
 */
export function StatusBar({ indexing, progress, progressPct, vision, total }: Props) {
  return (
    <footer className="statusbar">
      {indexing && (
        <div className={`statusbar-progress${progressPct === null ? " indeterminate" : ""}`}>
          <div
            className="bar"
            style={progressPct === null ? undefined : { width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="statusbar-item">
        {indexing ? (
          <>
            <span className="spinner" />
            Indexing… {progress?.indexed.toLocaleString()} assets
            {progress?.total ? ` of ~${progress.total.toLocaleString()}` : ""}
          </>
        ) : vision ? (
          <>
            <span className="spinner" />
            Analyzing photos… {vision.processed.toLocaleString()} /{" "}
            {vision.total.toLocaleString()}
          </>
        ) : (
          <span className="statusbar-idle">
            {total.toLocaleString()} {total === 1 ? "asset" : "assets"}
          </span>
        )}
      </div>

      {indexing && progressPct !== null && (
        <div className="statusbar-item statusbar-pct">{Math.round(progressPct)}%</div>
      )}
      {!indexing && vision && vision.total > 0 && (
        <div className="statusbar-item statusbar-pct">
          {Math.round((vision.processed / vision.total) * 100)}%
        </div>
      )}
    </footer>
  );
}
