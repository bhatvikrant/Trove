import type { AssetFilter, Kind } from "../types";
import { prettyScene } from "./FiltersMenu";

const KIND_LABEL: Record<Kind, string> = {
  image: "Photos",
  video: "Videos",
  audio: "Audio",
  pdf: "PDFs",
  other: "Files",
};

/** A slim, removable-chip summary of the active (non-date) filters. */
export function FilterChips({
  filter,
  onChange,
}: {
  filter: AssetFilter;
  onChange: (f: AssetFilter) => void;
}) {
  const chips: { key: string; label: string; clear: () => void }[] = [];

  filter.kinds.forEach((k) =>
    chips.push({
      key: `k:${k}`,
      label: KIND_LABEL[k],
      clear: () => onChange({ ...filter, kinds: filter.kinds.filter((x) => x !== k) }),
    })
  );
  if (filter.favorite)
    chips.push({
      key: "fav",
      label: "⭐ Favorites",
      clear: () => onChange({ ...filter, favorite: false }),
    });
  if (filter.orientation)
    chips.push({
      key: "orient",
      label: filter.orientation[0].toUpperCase() + filter.orientation.slice(1),
      clear: () => onChange({ ...filter, orientation: null }),
    });
  filter.cameras.forEach((c) =>
    chips.push({
      key: `c:${c}`,
      label: c,
      clear: () => onChange({ ...filter, cameras: filter.cameras.filter((x) => x !== c) }),
    })
  );
  filter.formats.forEach((f) =>
    chips.push({
      key: `f:${f}`,
      label: f.toUpperCase(),
      clear: () => onChange({ ...filter, formats: filter.formats.filter((x) => x !== f) }),
    })
  );
  filter.scenes.forEach((s) =>
    chips.push({
      key: `s:${s}`,
      label: prettyScene(s),
      clear: () => onChange({ ...filter, scenes: filter.scenes.filter((x) => x !== s) }),
    })
  );

  if (chips.length === 0) return null;

  return (
    <div className="filter-chips">
      <span className="fc-label">Filters</span>
      {chips.map((c) => (
        <span key={c.key} className="fc-chip">
          {c.label}
          <button onClick={c.clear} aria-label={`Remove ${c.label}`}>
            ✕
          </button>
        </span>
      ))}
      <button
        className="fc-clear"
        onClick={() =>
          onChange({
            ...filter,
            kinds: [],
            favorite: false,
            cameras: [],
            formats: [],
            orientation: null,
            scenes: [],
          })
        }
      >
        Clear all
      </button>
    </div>
  );
}
