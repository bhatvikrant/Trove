import { useEffect, useMemo, useRef, useState } from "react";
import type { Places } from "../types";
import { WORLD_LAND } from "../worldLand";

interface Pin {
  country: string;
  city: string;
  count: number;
  x: number; // lon + 180  (0..360)
  y: number; // 90 - lat   (0..180)
}

interface View {
  s: number;
  tx: number;
  ty: number;
}

interface Hover {
  label: string;
  x: number;
  y: number;
}

const MIN_S = 1;
const MAX_S = 16;

// A map marker whose tip sits at (12, 22) in its local 24×24 box.
const MARKER = "M12 22C12 22 5 14.5 5 10a7 7 0 1 1 14 0c0 4.5-7 12-7 12z";

function clampView(v: View): View {
  return {
    s: v.s,
    tx: Math.min(0, Math.max(360 * (1 - v.s), v.tx)),
    ty: Math.min(0, Math.max(180 * (1 - v.s), v.ty)),
  };
}

// Screen point → viewBox (0..360, 0..180) coordinates.
function toVB(svg: SVGSVGElement | null, cx: number, cy: number) {
  if (!svg) return null;
  const pt = svg.createSVGPoint();
  pt.x = cx;
  pt.y = cy;
  const m = svg.getScreenCTM();
  if (!m) return null;
  const p = pt.matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

export function PlacesMap({
  places,
  onFocusPlace,
}: {
  places: Places | null;
  onFocusPlace: (p: { country: string; city: string }) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState<Hover | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

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
    return out.sort((a, b) => a.count - b.count);
  }, [places]);

  const located = places ? places.total - places.noLocation : 0;

  const zoomAt = (vbx: number, vby: number, factor: number) => {
    setView((v) => {
      const ns = Math.min(MAX_S, Math.max(MIN_S, v.s * factor));
      const wx = (vbx - v.tx) / v.s;
      const wy = (vby - v.ty) / v.s;
      return clampView({ s: ns, tx: vbx - ns * wx, ty: vby - ns * wy });
    });
  };

  // Wheel zoom toward the cursor (native listener so preventDefault works).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toVB(svgRef.current, e.clientX, e.clientY);
      if (p) zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toVB(svgRef.current, e.clientX, e.clientY);
    if (!p) return;
    pan.current = p;
    moved.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    const p = toVB(svgRef.current, e.clientX, e.clientY);
    if (!p) return;
    const dx = p.x - pan.current.x;
    const dy = p.y - pan.current.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved.current = true;
    pan.current = p;
    setView((v) => clampView({ s: v.s, tx: v.tx + dx, ty: v.ty + dy }));
  };
  const endPan = () => {
    pan.current = null;
  };

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
        <div
          className="places-map-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerLeave={() => {
            endPan();
            setHover(null);
          }}
          onDoubleClick={() => setView({ s: 1, tx: 0, ty: 0 })}
        >
          <svg viewBox="0 0 360 180" className="world-svg" ref={svgRef} preserveAspectRatio="xMidYMid meet">
            <rect x="0" y="0" width="360" height="180" className="world-ocean" />
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
              <path
                d={WORLD_LAND}
                className="world-land-path"
                fillRule="evenodd"
                vectorEffect="non-scaling-stroke"
              />
            </g>
            <g>
              {pins.map((p) => {
                const cx = view.tx + view.s * p.x;
                const cy = view.ty + view.s * p.y;
                if (cx < -12 || cx > 372 || cy < -12 || cy > 192) return null;
                const k = Math.min(0.42 + Math.sqrt(p.count) * 0.03, 0.72);
                return (
                  <g
                    key={`${p.country}:${p.city}`}
                    className="map-pin"
                    transform={`translate(${cx} ${cy}) scale(${k})`}
                    onMouseEnter={(e) => showHover(p, e)}
                    onMouseMove={(e) => showHover(p, e)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => {
                      if (!moved.current) onFocusPlace({ country: p.country, city: p.city });
                    }}
                  >
                    <g transform="translate(-12 -22)">
                      <path d={MARKER} className="marker-body" />
                      <circle cx="12" cy="10" r="2.8" className="marker-dot" />
                    </g>
                  </g>
                );
              })}
            </g>
          </svg>

          {hover && (
            <div className="map-tip" style={{ left: hover.x, top: hover.y - 12 }}>
              {hover.label}
            </div>
          )}

          <div className="map-zoom">
            <button onClick={() => zoomAt(180, 90, 1.5)} title="Zoom in" aria-label="Zoom in">＋</button>
            <button onClick={() => zoomAt(180, 90, 1 / 1.5)} title="Zoom out" aria-label="Zoom out">－</button>
            <button
              onClick={() => setView({ s: 1, tx: 0, ty: 0 })}
              title="Reset"
              aria-label="Reset zoom"
              disabled={view.s === 1}
            >
              ⟲
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
