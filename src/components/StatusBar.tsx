import { openInFinder } from "../api";
import { folderName } from "../paths";
import { showToast } from "../toast";
import type { AnalysisRun } from "../types";

interface Props {
  /** The open folder's absolute path. */
  root: string;
  /** True from the start of an analysis run until the backend reports it done. */
  running: boolean;
  /** What the run is doing, e.g. `Scanning… 12,300 assets found`. */
  label: string | null;
  /** Run completion 0–100, or null while the total is still unknown. */
  pct: number | null;
  /** Assets currently in view (respecting the active filter). */
  total: number;
  /** How long the run in flight has been going. */
  elapsedMs: number;
  /** The last completed run for this folder, from a previous session too. */
  lastAnalysis: AnalysisRun | null;
  /** Stop the run in flight, keeping whatever it indexed so far. */
  onCancel?: () => void;
}

/** A running timer: `0:07`, `4:31`, `1:12:40`. */
function clock(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A finished duration, read as prose: `8s`, `4m 31s`, `1h 12m`. */
function duration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Persistent bottom status bar. Shows indexing / analysis activity (with a thin
 * progress line and a live elapsed timer) while work is in flight, and an idle
 * asset count — plus how long the last analysis took — otherwise.
 */
/**
 * The open folder, named in the footer with its full path on hover. Clicking
 * opens it in Finder — a path you can see is one you'll want to get to.
 */
function FolderChip({ root }: { root: string }) {
  const reveal = async () => {
    try {
      await openInFinder(root);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  };

  return (
    <button
      className="statusbar-folder"
      title={`${root}\nClick to open in Finder`}
      onClick={reveal}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <span>{folderName(root)}</span>
    </button>
  );
}

export function StatusBar({
  root,
  running,
  label,
  pct,
  total,
  elapsedMs,
  lastAnalysis,
  onCancel,
}: Props) {
  return (
    <footer className="statusbar">
      {running && (
        <div className={`statusbar-progress${pct === null ? " indeterminate" : ""}`}>
          <div className="bar" style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}

      <FolderChip root={root} />

      <div className="statusbar-item">
        {running ? (
          <>
            <span className="spinner" />
            <span className="statusbar-label">{label}</span>
          </>
        ) : (
          <span className="statusbar-idle">
            {total.toLocaleString()} {total === 1 ? "asset" : "assets"}
            {lastAnalysis && (
              <>
                {" · "}
                <span
                  title={`Last analysis finished ${new Date(
                    lastAnalysis.finishedAt * 1000
                  ).toLocaleString()}`}
                >
                  analyzed in {duration(lastAnalysis.durationMs)}
                </span>
              </>
            )}
          </span>
        )}
      </div>

      {running && onCancel && (
        <button
          className="statusbar-stop"
          onClick={onCancel}
          title="Stop indexing this folder (what's indexed so far is kept)"
        >
          Stop
        </button>
      )}

      {running && (
        <div className="statusbar-item statusbar-elapsed" title="Time spent analyzing">
          {clock(elapsedMs)}
        </div>
      )}

      {running && pct !== null && (
        <div className="statusbar-item statusbar-pct">{Math.round(pct)}%</div>
      )}
    </footer>
  );
}
