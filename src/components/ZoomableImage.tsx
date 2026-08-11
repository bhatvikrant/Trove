import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

const MIN = 1;
const MAX = 8;

interface Transform {
  s: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { s: 1, x: 0, y: 0 };

/**
 * An image that can be zoomed (wheel / trackpad pinch, double-click, or the
 * on-image controls) and panned by dragging once zoomed in. Resets to fit
 * whenever the source changes.
 */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState<Transform>(IDENTITY);
  // Mirror of `t` for event handlers that need the latest value synchronously.
  const tRef = useRef<Transform>(IDENTITY);
  tRef.current = t;
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Reset to fit whenever the displayed image changes.
  useEffect(() => setT(IDENTITY), [src]);

  // Keep the pan within bounds so the image can't be dragged fully off-screen.
  const clamp = (s: number, x: number, y: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x, y };
    const maxX = ((s - 1) * rect.width) / 2;
    const maxY = ((s - 1) * rect.height) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };

  // Apply a new scale, keeping the point at (cx, cy) — offsets from the wrap's
  // centre — anchored under the cursor.
  const applyZoom = useCallback(
    (nextScale: (s: number) => number, cx = 0, cy = 0) => {
      setT((cur) => {
        const s1 = Math.max(MIN, Math.min(MAX, nextScale(cur.s)));
        if (s1 === 1) return IDENTITY;
        const x = cx - (s1 / cur.s) * (cx - cur.x);
        const y = cy - (s1 / cur.s) * (cy - cur.y);
        const c = clamp(s1, x, y);
        return { s: s1, x: c.x, y: c.y };
      });
    },
    []
  );

  // Wheel/pinch zoom. Attached natively so we can preventDefault (React's wheel
  // listener is passive and can't stop the page from doing anything else).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // When zoomed in, a plain two-finger scroll pans; trackpad pinch (which
      // arrives as ctrl+wheel) always zooms.
      if (!e.ctrlKey && tRef.current.s > 1) {
        setT((cur) => {
          const c = clamp(cur.s, cur.x - e.deltaX, cur.y - e.deltaY);
          return { ...cur, x: c.x, y: c.y };
        });
        return;
      }
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const factor = Math.exp(-e.deltaY * 0.0018);
      applyZoom((s) => s * factor, cx, cy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    applyZoom((s) => (s > 1 ? 1 : 2.5), cx, cy);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (t.s <= 1) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const nx = drag.current.tx + (e.clientX - drag.current.x);
    const ny = drag.current.ty + (e.clientY - drag.current.y);
    setT((cur) => {
      const c = clamp(cur.s, nx, ny);
      return { ...cur, x: c.x, y: c.y };
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  const zoomed = t.s > 1;

  return (
    <div
      ref={wrapRef}
      className={`zoom-wrap${zoomed ? " zoomed" : ""}`}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <img
        src={src}
        alt={alt}
        decoding="async"
        draggable={false}
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          transition: drag.current ? "none" : "transform 0.12s ease-out",
        }}
      />

      <div className="zoom-controls" onDoubleClick={(e) => e.stopPropagation()}>
        <button
          className="zoom-btn"
          title="Zoom out"
          aria-label="Zoom out"
          disabled={t.s <= MIN}
          onClick={() => applyZoom((s) => s / 1.4)}
        >
          −
        </button>
        <button
          className="zoom-level"
          title="Reset zoom"
          aria-label="Reset zoom"
          disabled={!zoomed}
          onClick={() => setT(IDENTITY)}
        >
          {Math.round(t.s * 100)}%
        </button>
        <button
          className="zoom-btn"
          title="Zoom in"
          aria-label="Zoom in"
          disabled={t.s >= MAX}
          onClick={() => applyZoom((s) => s * 1.4)}
        >
          +
        </button>
      </div>
    </div>
  );
}
