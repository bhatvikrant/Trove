import { useState } from "react";
import type { SavedSpecialDate } from "../types";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface Props {
  occasions: SavedSpecialDate[] | null;
  onAdd: (month: number, day: number, label: string | null) => void;
  onDelete: (id: number) => void;
  onPlay: (occ: SavedSpecialDate) => void;
}

/** The Occasions tab's main content: add occasions and play a slideshow for
 *  each one (its photos from that day across every year). */
export function OccasionsView({ occasions, onAdd, onDelete, onPlay }: Props) {
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");

  const add = () => {
    if (!date) return;
    const [, m, d] = date.split("-").map(Number);
    if (!m || !d) return;
    onAdd(m, d, label.trim() || null);
    setDate("");
    setLabel("");
  };

  return (
    <div className="occasions-view">
      <header className="occ-head">
        <h2>Occasions</h2>
        <p>
          Save birthdays, anniversaries, and other special days. Play a
          slideshow of that day’s photos from every year.
        </p>
      </header>

      <div className="occ-add">
        <input
          type="date"
          className="sidebar-search occ-date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label="Occasion date"
        />
        <input
          type="text"
          className="sidebar-search occ-label"
          placeholder="Label (e.g. Mom’s birthday)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label="Occasion label"
        />
        <button className="btn primary" onClick={add} disabled={!date}>
          Add
        </button>
      </div>

      {occasions === null ? (
        <div className="empty" style={{ flex: 1 }}>
          <span className="spinner" style={{ width: 22, height: 22 }} />
        </div>
      ) : occasions.length === 0 ? (
        <div className="empty" style={{ flex: 1 }}>
          <div className="glyph">🎂</div>
          <h2>No occasions yet</h2>
          <p>Add a date above to start collecting its memories.</p>
        </div>
      ) : (
        <div className="occ-grid">
          {occasions.map((o) => (
            <div className="occ-card" key={o.id}>
              <div className="occ-cal" aria-hidden="true">
                <span className="occ-cal-mon">{MONTHS[o.month - 1]}</span>
                <span className="occ-cal-day">{o.day}</span>
              </div>
              <div className="occ-body">
                <div className="occ-label">
                  {o.label ?? `${MONTHS[o.month - 1]} ${o.day}`}
                </div>
                <div className="occ-count">
                  {o.count.toLocaleString()} {o.count === 1 ? "item" : "items"} across all years
                </div>
              </div>
              <button
                className="btn primary occ-play"
                disabled={o.count === 0}
                onClick={() => onPlay(o)}
                title={o.count === 0 ? "No photos from this day yet" : "Play slideshow"}
              >
                ▶ Play
              </button>
              <button
                className="occ-del"
                onClick={() => onDelete(o.id)}
                aria-label="Delete occasion"
                title="Delete"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
