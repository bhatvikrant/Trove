import { CalendarPicker } from "./CalendarPicker";
import { FiltersMenu } from "./FiltersMenu";
import type { AssetFilter } from "../types";

interface Props {
  root: string | null;
  filter: AssetFilter;
  onFilter: (f: AssetFilter) => void;
  onPickFolder: () => void;
  onRescan: () => void;
  onHome: () => void;
  onSettings: () => void;
  canRescan: boolean;
}

export function Navbar({
  root,
  filter,
  onFilter,
  onPickFolder,
  onRescan,
  onHome,
  onSettings,
  canRescan,
}: Props) {
  return (
    // `data-tauri-drag-region` makes the bar behave like a native title bar:
    // click-drag moves the window, double-click toggles maximize. It applies to
    // the element it's on, so the title and spacer carry it too; buttons don't,
    // so they stay clickable.
    <div className="navbar" data-tauri-drag-region>
      <span className="navbar-title" data-tauri-drag-region>
        Trove
      </span>

      {/* Action buttons are only useful once a folder is open. */}
      {root && (
        <>
          <button className="btn icon" onClick={onHome} title="Back to start">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
            </svg>
          </button>

          <button className="btn" onClick={onPickFolder} title="Open a folder">
            📁 Open
          </button>

          <button
            className="btn icon"
            onClick={onRescan}
            disabled={!canRescan}
            title="Re-scan for changes"
            style={{ opacity: canRescan ? 1 : 0.4 }}
          >
            ↻
          </button>
        </>
      )}

      <div className="spacer" data-tauri-drag-region />

      {root && (
        <>
          <FiltersMenu filter={filter} onChange={onFilter} />
          <CalendarPicker
            range={{ start: filter.start, end: filter.end }}
            onChange={(r) => onFilter({ ...filter, start: r.start, end: r.end })}
          />
        </>
      )}

      <button className="btn icon" onClick={onSettings} title="Settings (⌘,)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}
