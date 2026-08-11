import { useMemo, useRef, useState } from "react";
import type { Places } from "../types";
import { WORLD_LAND } from "../worldLand";

interface Pin {
  country: string;
  city: string;
  count: number;
  x: number; // lon + 180  (0..360)
  y: number; // 90 - lat   (0..180)
}

interface Hover {
  label: string;
  x: number; // px within the stage
  y: number;
}

export function PlacesMap({
  places,
  onFocusPlace,
}: {
  places: Places | null;
  onFocusPlace: (p: { country: string; city: string }) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const pins = useMemo<Pin[]>(() => {
    if (!places) return [];
    const out: Pin[] = [];
    for (const co of places.countries) {
      for (const ci of co.cities) {
        out.push({
          country: co.country,
          city: ci.city,
          count: ci.count,
          x: ci.lon + 180,
          y: 90 - ci.lat,
        });
      }
    }
    return out.sort((a, b) => a.count - b.count); // big pins drawn last
  }, [places]);

  const located = places ? places.total - places.noLocation : 0;

  const showHover = (pin: Pin, e: React.MouseEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({
      label: `${pin.city}, ${pin.country} · ${pin.count.toLocaleString()}`,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div className="places-map">
      <div className="places-map-head">
        <span>
          {located.toLocaleString()} located
          {places && places.noLocation > 0
            ? ` · ${places.noLocation.toLocaleString()} without location`
            : ""}
        </span>
      </div>
      {pins.length === 0 ? (
        <div className="empty" style={{ flex: 1 }}>
          <div className="glyph">🌍</div>
          <p>No location data in these assets.</p>
        </div>
      ) : (
        <div className="places-map-stage" ref={stageRef}>
          <svg viewBox="0 0 360 180" className="world-svg" preserveAspectRatio="xMidYMid meet">
            <rect x="0" y="0" width="360" height="180" className="world-ocean" />
            <path d={WORLD_LAND} className="world-land-path" />
            <g className="world-grat">
              {[30, 60, 90, 120, 150].map((y) => (
                <line key={`h${y}`} x1="0" y1={y} x2="360" y2={y} />
              ))}
              {[60, 120, 180, 240, 300].map((x) => (
                <line key={`v${x}`} x1={x} y1="0" x2={x} y2="180" />
              ))}
            </g>
            <g>
              {pins.map((p) => {
                const r = Math.min(1.8 + Math.sqrt(p.count) * 0.7, 6);
                return (
                  <circle
                    key={`${p.country}:${p.city}`}
                    className="map-pin"
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    onMouseEnter={(e) => showHover(p, e)}
                    onMouseMove={(e) => showHover(p, e)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onFocusPlace({ country: p.country, city: p.city })}
                  />
                );
              })}
            </g>
          </svg>
          {hover && (
            <div
              className="map-tip"
              style={{ left: hover.x, top: hover.y - 12 }}
            >
              {hover.label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
