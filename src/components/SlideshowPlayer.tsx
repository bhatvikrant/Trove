import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { assetUrl, getPreview } from "../api";
import type { SlideshowConfig, SlideshowItem } from "../types";

// Resolve a screen-sized image URL (falls back to the original).
const urlCache = new Map<string, string>();
async function imageUrl(path: string): Promise<string> {
  const cached = urlCache.get(path);
  if (cached) return cached;
  const url = (await getPreview(path)) ?? assetUrl(path);
  urlCache.set(path, url);
  return url;
}
function preload(path: string) {
  imageUrl(path).then((url) => {
    const im = new Image();
    im.decoding = "async";
    im.src = url;
  });
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface Slide {
  item: SlideshowItem;
  url: string; // image url (empty for non-images)
  idx: number;
  kb: number; // ken-burns variant
}

interface Props {
  items: SlideshowItem[];
  config: SlideshowConfig;
  onClose: () => void;
}

export function SlideshowPlayer({ items, config, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  const [cur, setCur] = useState<Slide | null>(null);
  const [prev, setPrev] = useState<Slide | null>(null);
  const [playing, setPlaying] = useState(true);
  const [controls, setControls] = useState(true);
  // Refs mirror the latest index/slide so async advance logic doesn't need to
  // nest setState calls (which misbehave under async + StrictMode).
  const idxRef = useRef(0);
  const curRef = useRef<Slide | null>(null);
  curRef.current = cur;
  const advanceTimer = useRef<number | null>(null);
  const fadeTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  const reduceMotion = useRef(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
  const fade = reduceMotion.current || !config.crossfade ? 0 : 600;

  // Enter OS fullscreen for an immersive show; restore on exit.
  useEffect(() => {
    const win = getCurrentWindow();
    let wasFullscreen = false;
    win.isFullscreen().then((f) => {
      wasFullscreen = f;
      if (!f) win.setFullscreen(true).catch(() => {});
    });
    return () => {
      if (!wasFullscreen) win.setFullscreen(false).catch(() => {});
    };
  }, []);

  // Load the slide for a given index (resolving its image url first), moving the
  // outgoing slide into the fading `prev` layer.
  const show = useCallback(
    async (nextIdx: number) => {
      const item = items[nextIdx];
      if (!item) return;
      idxRef.current = nextIdx;
      setIdx(nextIdx);
      const url = item.kind === "image" ? await imageUrl(item.path) : "";
      const slide: Slide = { item, url, idx: nextIdx, kb: nextIdx % 4 };
      setPrev(curRef.current);
      setCur(slide);
      // Preload the next image.
      const nxt = items[(nextIdx + 1) % items.length];
      if (nxt && nxt.kind === "image") preload(nxt.path);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (fade > 0) {
        fadeTimer.current = window.setTimeout(() => setPrev(null), fade + 40);
      } else {
        setPrev(null);
      }
    },
    [items, fade]
  );

  // Load the first slide on mount / when the item list changes.
  useEffect(() => {
    show(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const go = useCallback(
    (delta: number) => {
      let next = idxRef.current + delta;
      if (next >= items.length) {
        if (!config.loop) {
          setPlaying(false);
          return;
        }
        next = 0;
      } else if (next < 0) {
        next = items.length - 1;
      }
      show(next);
    },
    [items.length, config.loop, show]
  );

  // Auto-advance: images/pdf on a timer; video/audio advance when they end.
  useEffect(() => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    if (!playing || !cur) return;
    const k = cur.item.kind;
    if (k === "video" || k === "audio") return; // handled by onEnded
    advanceTimer.current = window.setTimeout(
      () => go(1),
      Math.max(1, config.durationSec) * 1000
    );
    return () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
  }, [playing, cur, config.durationSec, go]);

  // Auto-hide the controls after idle.
  const poke = useCallback(() => {
    setControls(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setControls(false), 2600);
  }, []);
  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [poke]);

  const toggleFullscreen = useCallback(() => {
    const win = getCurrentWindow();
    win.isFullscreen().then((f) => win.setFullscreen(!f).catch(() => {}));
  }, []);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key.toLowerCase() === "f") toggleFullscreen();
      poke();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, poke, toggleFullscreen]);

  const renderSlide = (slide: Slide, entering: boolean) => {
    const { item, url, kb } = slide;
    const kbClass =
      config.kenBurns && !reduceMotion.current && item.kind === "image"
        ? ` kb kb${kb}`
        : "";
    return (
      <div
        key={slide.idx}
        className={`ss-layer${entering ? " entering" : ""}`}
        style={{
          transition: fade > 0 ? `opacity ${fade}ms ease` : "none",
          opacity: entering ? 1 : 0,
        }}
      >
        {item.kind === "image" && (
          <img
            className={`ss-media${kbClass}`}
            src={url}
            alt=""
            style={{ animationDuration: `${config.durationSec + 1}s` }}
          />
        )}
        {item.kind === "video" && (
          <video
            className="ss-media"
            src={assetUrl(item.path)}
            autoPlay
            muted={config.muteVideo}
            controls={false}
            onEnded={() => go(1)}
          />
        )}
        {item.kind === "audio" && (
          <div className="ss-audio">
            <div className="ss-audio-glyph">🎵</div>
            <div className="ss-audio-name">{item.name}</div>
            <audio src={assetUrl(item.path)} autoPlay controls onEnded={() => go(1)} />
          </div>
        )}
        {item.kind === "pdf" && (
          <iframe className="ss-pdf" src={assetUrl(item.path)} title={item.name} />
        )}
        {item.kind === "other" && (
          <div className="ss-audio">
            <div className="ss-audio-glyph">📎</div>
            <div className="ss-audio-name">{item.name}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`slideshow${controls ? "" : " hide-cursor"}`}
      onMouseMove={poke}
      onClick={poke}
    >
      <div className="ss-stage">
        {prev && renderSlide(prev, false)}
        {cur && renderSlide(cur, true)}
      </div>

      {config.captions && cur && (
        <div className={`ss-caption${controls ? "" : " dim"}`}>
          <div className="ss-cap-date">{fmtDate(cur.item.captureTs)}</div>
          <div className="ss-cap-meta">
            {cur.item.people.length > 0 && (
              <span>{cur.item.people.join(", ")}</span>
            )}
            {cur.item.place && <span>{cur.item.place}</span>}
          </div>
        </div>
      )}

      <button className="ss-exit" title="Exit (Esc)" aria-label="Exit slideshow" onClick={onClose}>
        ✕
      </button>

      <div className={`ss-controls${controls ? "" : " hidden"}`}>
        <button className="ss-ctl" title="Previous (←)" aria-label="Previous" onClick={() => go(-1)}>
          ‹
        </button>
        <button
          className="ss-ctl play"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "❙❙" : "▶"}
        </button>
        <button className="ss-ctl" title="Next (→)" aria-label="Next" onClick={() => go(1)}>
          ›
        </button>
        <div className="ss-count">
          {idx + 1} / {items.length}
        </div>
        <div className="ss-progress">
          <div
            className="ss-progress-bar"
            style={{ width: `${((idx + 1) / items.length) * 100}%` }}
          />
        </div>
        <button
          className="ss-ctl"
          title="Toggle fullscreen (F)"
          aria-label="Toggle fullscreen"
          onClick={toggleFullscreen}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}
