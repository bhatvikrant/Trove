import type { Person } from "../types";
import { FaceThumb } from "./FaceThumb";

export function PeopleGrid({
  people,
  onFocusPerson,
}: {
  people: Person[] | null;
  onFocusPerson: (p: { clusterId: number }) => void;
}) {
  if (!people) {
    return (
      <div className="empty" style={{ flex: 1 }}>
        <span className="spinner" style={{ width: 24, height: 24 }} />
        <p>Finding people…</p>
      </div>
    );
  }
  if (people.length === 0) {
    return (
      <div className="empty" style={{ flex: 1 }}>
        <div className="glyph">🧑‍🤝‍🧑</div>
        <h2>No people yet</h2>
        <p>
          People appear here once your photos have been analyzed. Recognition is
          best-effort — name a group and it sticks.
        </p>
      </div>
    );
  }
  return (
    <div className="people-grid-wrap">
      <div className="people-grid">
        {people.map((p) => (
          <button
            key={p.clusterId}
            className="people-card"
            onClick={() => onFocusPerson({ clusterId: p.clusterId })}
          >
            <FaceThumb
              path={p.path}
              box={{ x: p.x, y: p.y, w: p.w, h: p.h }}
              size={160}
            />
            <span className={`people-card-name ${p.name ? "" : "unnamed"}`}>
              {p.name ?? "Add name"}
            </span>
            <span className="people-card-count">
              {p.count.toLocaleString()} photos
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
