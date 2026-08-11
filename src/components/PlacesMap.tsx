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

// The map transform maps geographic units (0..360 × 0..180) to on-screen
// pixels: screenX = tx + s*geoX, screenY = ty + s*geoY. `s` is px per geo-unit.
interface View {
  s: number;
  tx: number;
  ty: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Hover {
  label: string;
  x: number;
  y: number;
}

const WORLD: Box = { x0: 0, y0: 0, x1: 360, y1: 180 };

// A map marker whose tip sits at (12, 22) in its local 24×24 box.
const MARKER = "M12 22C12 22 5 14.5 5 10a7 7 0 1 1 14 0c0 4.5-7 12-7 12z";

// Screen point → SVG-user (pixel) coordinates.
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
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState<Hover | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  // Kept in a ref so the once-registered wheel listener sees the latest values.
  const sizeRef = useRef(size);
  sizeRef.current = size;

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

  // The geographic region to frame: the pins' bounding box (padded, with a
  // minimum span so a single city isn't absurdly zoomed), else the whole world.
  const region = useMemo<Box>(() => {
    if (pins.length === 0) return WORLD;
    let b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of pins) {
      b = {
        x0: Math.min(b.x0, p.x),
        y0: Math.min(b.y0, p.y),
        x1: Math.max(b.x1, p.x),
        y1: Math.max(b.y1, p.y),
      };
    }
    const padX = Math.max((b.x1 - b.x0) * 0.4, 14);
    const padY = Math.max((b.y1 - b.y0) * 0.4, 14);
    return {
      x0: Math.max(0, b.x0 - padX),
      y0: Math.max(0, b.y0 - padY),
      x1: Math.min(360, b.x1 + padX),
      y1: Math.min(180, b.y1 + padY),
    };
  }, [pins]);

  // Smallest scale = whole world fits the pane; deepest zoom is a multiple of it.
  const scaleBounds = (w: number, h: number) => {
    const min = w && h ? Math.min(w / 360, h / 180) : 0.001;
    return { min, max: min * 64 };
  };

  const clampView = (v: View, w: number, h: number): View => {
    const worldW = 360 * v.s;
    const worldH = 180 * v.s;
    // If the world is smaller than the pane on an axis, centre it; otherwise
    // keep it covering the pane (no panning past the edges into blank space).
    const tx =
      worldW <= w ? (w - worldW) / 2 : Math.min(0, Math.max(w - worldW, v.tx));
    const ty =
      worldH <= h ? (h - worldH) / 2 : Math.min(0, Math.max(h - worldH, v.ty));
    return { s: v.s, tx, ty };
  };

  // Fit a region to fill the pane (contain, with a small margin).
  const fitTo = (b: Box, w: number, h: number): View => {
    if (!w || !h) return { s: 1, tx: 0, ty: 0 };
    const gw = Math.max(1e-3, b.x1 - b.x0);
    const gh = Math.max(1e-3, b.y1 - b.y0);
    const { min, max } = scaleBounds(w, h);
    const s = Math.min(max, Math.max(min, Math.min(w / gw, h / gh) * 0.92));
    const tx = w / 2 - s * (b.x0 + b.x1) / 2;
    const ty = h / 2 - s * (b.y0 + b.y1) / 2;
    return clampView({ s, tx, ty }, w, h);
  };

  // Track the pane's pixel size so the map can fill it exactly (no letterboxing).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // (Re)frame the region whenever the data or pane size changes.
  useEffect(() => {
    if (size.w && size.h) setView(fitTo(region, size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, size.w, size.h]);

  const zoomAt = (px: number, py: number, factor: number) => {
    const { w, h } = sizeRef.current;
    setView((v) => {
      const { min, max } = scaleBounds(w, h);
      const ns = Math.min(max, Math.max(min, v.s * factor));
      const wx = (px - v.tx) / v.s;
      const wy = (py - v.ty) / v.s;
      return clampView({ s: ns, tx: px - ns * wx, ty: py - ns * wy }, w, h);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const { w, h } = sizeRef.current;
    setView((v) => clampView({ s: v.s, tx: v.tx + dx, ty: v.ty + dy }, w, h));
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

  const reset = () => setView(fitTo(region, size.w, size.h));
  const atHome =
    Math.abs(view.s - fitTo(region, size.w, size.h).s) < 1e-3;
  const { w, h } = size;

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
          onDoubleClick={reset}
        >
          {w > 0 && h > 0 && (
            <svg
              viewBox={`0 0 ${w} ${h}`}
              preserveAspectRatio="none"
              className="world-svg"
              ref={svgRef}
            >
              <rect x="0" y="0" width={w} height={h} className="world-ocean" />
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
                  if (cx < -30 || cx > w + 30 || cy < -30 || cy > h + 30)
                    return null;
                  const k = Math.min(1.2 + Math.sqrt(p.count) * 0.08, 2.2);
                  return (
                    <g
                      key={`${p.country}:${p.city}`}
                      className="map-pin"
                      transform={`translate(${cx} ${cy}) scale(${k})`}
                      onMouseEnter={(e) => showHover(p, e)}
                      onMouseMove={(e) => showHover(p, e)}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => {
                        if (!moved.current)
                          onFocusPlace({ country: p.country, city: p.city });
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
          )}

          {hover && (
            <div className="map-tip" style={{ left: hover.x, top: hover.y - 12 }}>
              {hover.label}
            </div>
          )}

          <div className="map-zoom">
            <button onClick={() => zoomAt(w / 2, h / 2, 1.5)} title="Zoom in" aria-label="Zoom in">
              ＋
            </button>
            <button onClick={() => zoomAt(w / 2, h / 2, 1 / 1.5)} title="Zoom out" aria-label="Zoom out">
              －
            </button>
            <button onClick={reset} title="Reset view" aria-label="Reset view" disabled={atHome}>
              ⟲
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
