import type { SavedSpecialDate } from "../types";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface Props {
  occasions: SavedSpecialDate[] | null;
  onPlay: (occ: SavedSpecialDate) => void;
  onDelete: (id: number) => void;
}

/** Compact occasions list in the sidebar — quick play/delete for each. */
export function OccasionsSidebar({ occasions, onPlay, onDelete }: Props) {
  if (!occasions || occasions.length === 0) {
    return (
      <div className="occ-side-empty">
        Add occasions in the panel to the right.
      </div>
    );
  }
  return (
    <div className="occ-side">
      {occasions.map((o) => (
        <div className="occ-side-row" key={o.id}>
          <button
            className="occ-side-play"
            disabled={o.count === 0}
            onClick={() => onPlay(o)}
            title="Play slideshow"
            aria-label="Play slideshow"
          >
            ▶
          </button>
          <span className="occ-side-body">
            <span className="occ-side-label">
              {o.label ?? `${MONTHS[o.month - 1]} ${o.day}`}
            </span>
            <span className="occ-side-sub">
              {MONTHS[o.month - 1]} {o.day} · {o.count.toLocaleString()}
            </span>
          </span>
          <button
            className="occ-side-del"
            onClick={() => onDelete(o.id)}
            aria-label="Delete occasion"
            title="Delete"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
