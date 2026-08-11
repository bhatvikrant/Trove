import { useRef, useState } from "react";
import type { Person } from "../types";
import { FaceThumb } from "./FaceThumb";

interface DragState {
  source: number;
  x: number;
  y: number;
  over: number | null;
  person: Person;
}

export function PeopleGrid({
  people,
  onFocusPerson,
  onMerge,
  onRename,
}: {
  people: Person[] | null;
  onFocusPerson: (p: { clusterId: number }) => void;
  onMerge: (source: number, target: number) => void;
  onRename: (clusterId: number, name: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const dragRef = useRef<{ source: number; over: number | null; moved: boolean } | null>(null);
  const skipBlur = useRef(false);

  // Pointer-based drag (not HTML5 DnD, which Tauri's native file-drop blocks).
  const onCardPointerDown = (e: React.PointerEvent, p: Person) => {
    if (editing || e.button !== 0) return;
    e.preventDefault(); // stop text selection starting on drag
    const sx = e.clientX;
    const sy = e.clientY;
    dragRef.current = { source: p.clusterId, over: null, moved: false };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!d.moved) document.body.classList.add("dragging-face");
      d.moved = true;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const card = el?.closest("[data-cluster]") as HTMLElement | null;
      const overId = card ? Number(card.dataset.cluster) : null;
      d.over = overId && overId !== d.source ? overId : null;
      setDrag({ source: p.clusterId, x: ev.clientX, y: ev.clientY, over: d.over, person: p });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dragging-face");
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (d.moved && d.over) onMerge(d.source, d.over);
      else if (!d.moved) onFocusPerson({ clusterId: d.source });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

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
          best-effort — drag one face onto another to merge them, and
          double-click a name to label them.
        </p>
      </div>
    );
  }

  const commit = (id: number) => {
    if (editing && editing.id === id) onRename(id, editing.value);
    setEditing(null);
  };

  return (
    <div className="people-grid-wrap">
      <div className="people-hint">
        Drag a face onto another to merge people; double-click a name to label.
      </div>
      <div className="people-grid">
        {people.map((p) => (
          <div
            key={p.clusterId}
            data-cluster={p.clusterId}
            className={`people-card ${drag?.over === p.clusterId ? "drop-target" : ""} ${drag?.source === p.clusterId ? "dragging" : ""}`}
            onPointerDown={(e) => onCardPointerDown(e, p)}
          >
            <FaceThumb
              path={p.path}
              box={{ x: p.x, y: p.y, w: p.w, h: p.h }}
              size={160}
            />
            {editing?.id === p.clusterId ? (
              <input
                className="rename-input people-card-input"
                value={editing.value}
                autoFocus
                placeholder="Name"
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setEditing({ id: p.clusterId, value: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    skipBlur.current = true;
                    commit(p.clusterId);
                  } else if (e.key === "Escape") {
                    skipBlur.current = true;
                    setEditing(null);
                  }
                }}
                onBlur={() => {
                  if (skipBlur.current) {
                    skipBlur.current = false;
                    return;
                  }
                  commit(p.clusterId);
                }}
              />
            ) : (
              <span
                className={`people-card-name ${p.name ? "" : "unnamed"}`}
                title="Double-click to name"
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={() => setEditing({ id: p.clusterId, value: p.name ?? "" })}
              >
                {p.name ?? "Add name"}
              </span>
            )}
            <span className="people-card-count">
              {p.count.toLocaleString()} photos
            </span>
          </div>
        ))}
      </div>

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          <FaceThumb
            path={drag.person.path}
            box={{ x: drag.person.x, y: drag.person.y, w: drag.person.w, h: drag.person.h }}
            size={160}
          />
        </div>
      )}
    </div>
  );
}
