import { CalendarPicker } from "./CalendarPicker";
import type { DateRange } from "../types";

interface Props {
  root: string | null;
  range: DateRange;
  onRange: (r: DateRange) => void;
  onPickFolder: () => void;
  onRescan: () => void;
  canRescan: boolean;
}

export function Navbar({
  root,
  range,
  onRange,
  onPickFolder,
  onRescan,
  canRescan,
}: Props) {
  return (
    <div className="navbar">
      <span className="navbar-title">Assets Viewer</span>

      <button className="btn" onClick={onPickFolder} title="Open a folder">
        📁 Open
      </button>

      {root && (
        <button
          className="btn icon"
          onClick={onRescan}
          disabled={!canRescan}
          title="Re-scan for changes"
          style={{ opacity: canRescan ? 1 : 0.4 }}
        >
          ↻
        </button>
      )}

      {root && (
        <span className="navbar-root" title={root}>
          {"‎" + root}
        </span>
      )}

      <div className="spacer" />

      <CalendarPicker range={range} onChange={onRange} />
    </div>
  );
}
