import { useEffect, useRef, useState } from "react";
import { getFacets } from "../api";
import type { AssetFilter, Facets, Kind, Orientation } from "../types";

const KINDS: { id: Kind; label: string }[] = [
  { id: "image", label: "Photos" },
  { id: "video", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "pdf", label: "PDFs" },
];

const ORIENTS: { id: Orientation | null; label: string }[] = [
  { id: null, label: "Any" },
  { id: "portrait", label: "Portrait" },
  { id: "landscape", label: "Landscape" },
  { id: "square", label: "Square" },
];

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

export function activeFacetCount(f: AssetFilter): number {
  return (
    (f.kinds.length ? 1 : 0) +
    (f.favorite ? 1 : 0) +
    (f.cameras.length ? 1 : 0) +
    (f.formats.length ? 1 : 0) +
    (f.orientation ? 1 : 0)
  );
}

export function FiltersMenu({
  filter,
  onChange,
}: {
  filter: AssetFilter;
  onChange: (f: AssetFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [facets, setFacets] = useState<Facets>({ cameras: [], formats: [] });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) getFacets().then(setFacets).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const n = activeFacetCount(filter);

  return (
    <div className="date-picker" ref={ref}>
      <button
        className={`date-chip ${n ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>⚙︎</span>
        <span>Filters</span>
        {n > 0 && <span className="filter-count">{n}</span>}
        <span style={{ opacity: 0.5, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div className="date-popover filters-pop">
          <section className="fsec">
            <h4>Media type</h4>
            <div className="chk-row">
              {KINDS.map((k) => (
                <label key={k.id} className={`chk ${filter.kinds.includes(k.id) ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={filter.kinds.includes(k.id)}
                    onChange={() => onChange({ ...filter, kinds: toggle(filter.kinds, k.id) })}
                  />
                  {k.label}
                </label>
              ))}
            </div>
          </section>

          <section className="fsec">
            <h4>Orientation</h4>
            <div className="seg">
              {ORIENTS.map((o) => (
                <button
                  key={String(o.id)}
                  className={`seg-btn ${filter.orientation === o.id ? "on" : ""}`}
                  onClick={() => onChange({ ...filter, orientation: o.id })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </section>

          <section className="fsec">
            <label className="chk single">
              <input
                type="checkbox"
                checked={filter.favorite}
                onChange={() => onChange({ ...filter, favorite: !filter.favorite })}
              />
              ⭐ Favorites only
            </label>
          </section>

          {facets.cameras.length > 0 && (
            <section className="fsec">
              <h4>Camera</h4>
              <div className="chk-list">
                {facets.cameras.map((c) => (
                  <label key={c.value} className={`chk ${filter.cameras.includes(c.value) ? "on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={filter.cameras.includes(c.value)}
                      onChange={() => onChange({ ...filter, cameras: toggle(filter.cameras, c.value) })}
                    />
                    <span className="chk-label">{c.value}</span>
                    <span className="chk-ct">{c.count.toLocaleString()}</span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {facets.formats.length > 0 && (
            <section className="fsec">
              <h4>Format</h4>
              <div className="chk-row">
                {facets.formats.map((f) => (
                  <label key={f.value} className={`chk ${filter.formats.includes(f.value) ? "on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={filter.formats.includes(f.value)}
                      onChange={() => onChange({ ...filter, formats: toggle(filter.formats, f.value) })}
                    />
                    {f.value.toUpperCase()}
                    <span className="chk-ct">{f.count.toLocaleString()}</span>
                  </label>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
