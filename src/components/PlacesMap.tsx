import { useMemo } from "react";
import type { Places } from "../types";

// Rough continent blobs in lon/lat space (x = lon+180, y = 90-lat) — a
// self-contained, offline map backdrop. Pins are placed by true projection.
const CONTINENTS: [number, number, number, number][] = [
  [80, 45, 30, 24], // North America
  [120, 108, 15, 28], // South America
  [196, 40, 18, 13], // Europe
  [202, 92, 22, 30], // Africa
  [272, 46, 44, 28], // Asia
  [316, 118, 17, 11], // Australia
];

interface Pin {
  country: string;
  city: string;
  count: number;
  x: number;
  y: number;
}

export function PlacesMap({
  places,
  onFocusPlace,
}: {
  places: Places | null;
  onFocusPlace: (p: { country: string; city: string }) => void;
}) {
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
        <div className="places-map-stage">
          <svg viewBox="0 0 360 180" className="world-svg" preserveAspectRatio="xMidYMid meet">
            <rect x="0" y="0" width="360" height="180" className="world-ocean" />
            <g className="world-grat">
              {[30, 60, 90, 120, 150].map((y) => (
                <line key={`h${y}`} x1="0" y1={y} x2="360" y2={y} />
              ))}
              {[60, 120, 180, 240, 300].map((x) => (
                <line key={`v${x}`} x1={x} y1="0" x2={x} y2="180" />
              ))}
            </g>
            <g className="world-land">
              {CONTINENTS.map(([cx, cy, rx, ry], i) => (
                <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} />
              ))}
            </g>
            <g>
              {pins.map((p) => {
                const r = Math.min(1.6 + Math.sqrt(p.count) * 0.7, 6);
                return (
                  <circle
                    key={`${p.country}:${p.city}`}
                    className="map-pin"
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    onClick={() => onFocusPlace({ country: p.country, city: p.city })}
                  >
                    <title>
                      {p.city}, {p.country} — {p.count.toLocaleString()}
                    </title>
                  </circle>
                );
              })}
            </g>
          </svg>
        </div>
      )}
    </div>
  );
}
