import { useState } from "react";
import type { Person } from "../types";
import { FaceThumb } from "./FaceThumb";

export function PeopleGrid({
  people,
  onFocusPerson,
  onMerge,
}: {
  people: Person[] | null;
  onFocusPerson: (p: { clusterId: number }) => void;
  onMerge: (source: number, target: number) => void;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

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
          best-effort — drag one face onto another to merge them, and name a
          group so it sticks.
        </p>
      </div>
    );
  }
  return (
    <div className="people-grid-wrap">
      <div className="people-hint">
        Drag a face onto another to merge people you recognize as the same.
      </div>
      <div className="people-grid">
        {people.map((p) => (
          <button
            key={p.clusterId}
            className={`people-card ${overId === p.clusterId && dragId !== p.clusterId ? "drop-target" : ""} ${dragId === p.clusterId ? "dragging" : ""}`}
            draggable
            onDragStart={(e) => {
              setDragId(p.clusterId);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(p.clusterId));
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              if (dragId !== null && dragId !== p.clusterId) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(p.clusterId);
              }
            }}
            onDragLeave={() => setOverId((o) => (o === p.clusterId ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              const source = Number(e.dataTransfer.getData("text/plain"));
              setOverId(null);
              setDragId(null);
              if (source && source !== p.clusterId) onMerge(source, p.clusterId);
            }}
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
