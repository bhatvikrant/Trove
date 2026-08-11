import type { Lens } from "../types";

const LENSES: { id: Lens; label: string; icon: string; ready: boolean }[] = [
  { id: "date", label: "Date", icon: "🗓️", ready: true },
  { id: "places", label: "Places", icon: "📍", ready: false },
  { id: "people", label: "People", icon: "👤", ready: false },
];

export function LensSwitcher({
  lens,
  onLens,
}: {
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  return (
    <div className="lens-switch">
      {LENSES.map((l) => (
        <button
          key={l.id}
          className={`lens-tab ${lens === l.id ? "on" : ""}`}
          disabled={!l.ready}
          onClick={() => l.ready && onLens(l.id)}
          title={l.ready ? l.label : `${l.label} — coming soon`}
        >
          <span className="lens-ico">{l.icon}</span>
          {l.label}
          {!l.ready && <span className="soon-tag">soon</span>}
        </button>
      ))}
    </div>
  );
}
