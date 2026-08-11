import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { assetUrl, getPreview, revealInFinder } from "../api";
import type { Asset } from "../types";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Resolved preview URLs by source path, and warm (decoded) <img> elements kept
// alive so navigating to a neighbor paints instantly from cache.
const previewUrlCache = new Map<string, string>();
const warmImages = new Map<string, HTMLImageElement>();

function warmImage(url: string) {
  if (warmImages.has(url)) return;
  const im = new Image();
  im.decoding = "async";
  im.src = url;
  im.decode?.().catch(() => {});
  warmImages.set(url, im);
  if (warmImages.size > 12) {
    const oldest = warmImages.keys().next().value as string | undefined;
    if (oldest) warmImages.delete(oldest);
  }
}

async function resolvePreview(asset: Asset): Promise<string> {
  const cached = previewUrlCache.get(asset.path);
  if (cached) return cached;
  const url = (await getPreview(asset.path)) ?? assetUrl(asset.path);
  previewUrlCache.set(asset.path, url);
  return url;
}

// Prefetch a neighbor's preview (generate + decode) ahead of navigation.
function prefetch(asset: Asset | null) {
  if (!asset || asset.kind !== "image") return;
  resolvePreview(asset).then(warmImage).catch(() => {});
}

interface Props {
  asset: Asset | null;
  total: number;
  position: { index: number; total: number } | null;
  onNavigate: (delta: number) => void;
  prevAsset: Asset | null;
  nextAsset: Asset | null;
  onRename: (asset: Asset, newName: string) => void;
  onDelete: (asset: Asset) => void;
  onToggleFavorite: (asset: Asset) => void;
  onClose: () => void;
  emptyOverride?: ReactNode;
}

export function PreviewPane({
  asset,
  total,
  position,
  onNavigate,
  prevAsset,
  nextAsset,
  onRename,
  onDelete,
  onToggleFavorite,
  onClose,
  emptyOverride,
}: Props) {
  const canCycle = !!position && position.total > 1;

  // Inline rename of the filename shown in the info bar.
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const skipBlur = useRef(false);
  useEffect(() => {
    setRenaming(false); // cancel any in-progress edit when the asset changes
  }, [asset?.id]);

  const commitRename = () => {
    if (asset) onRename(asset, nameValue);
    setRenaming(false);
  };

  // For images we show a cached, screen-sized preview; other kinds render the
  // original natively (video/pdf/audio elements handle their own loading).
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const originalUrl = useMemo(
    () => (asset ? assetUrl(asset.path) : null),
    [asset]
  );

  useEffect(() => {
    if (!asset || asset.kind !== "image") {
      setImgUrl(null);
      return;
    }
    const cached = previewUrlCache.get(asset.path);
    if (cached) {
      setImgUrl(cached); // instant path (prefetched or previously viewed)
      return;
    }
    let alive = true;
    setImgUrl(null); // show spinner rather than decoding the huge original
    resolvePreview(asset).then((url) => {
      warmImage(url);
      if (alive) setImgUrl(url);
    });
    return () => {
      alive = false;
    };
  }, [asset]);

  // Warm the neighbours so the next/prev step is instant.
  useEffect(() => {
    prefetch(prevAsset);
    prefetch(nextAsset);
  }, [prevAsset, nextAsset]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "VIDEO" || tag === "AUDIO") return; // let media controls handle it
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onNavigate(-1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      onNavigate(1);
    }
  };

  if (!asset) {
    return (
      <div className="preview">
        {emptyOverride ?? (
          <div className="empty">
            <div className="glyph">👁️</div>
            <h2>Select an asset to preview</h2>
            <p>
              {total > 0
                ? `Pick an asset from the tree on the left to preview it here. ${total.toLocaleString()} assets in view.`
                : "Choose an asset from the tree on the left."}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="preview"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ outline: "none" }}
    >
      <div className="preview-stage">
        <button
          className="preview-close"
          title="Close preview (Esc)"
          aria-label="Close preview"
          onClick={onClose}
        >
          ×
        </button>
        {canCycle && (
          <>
            <button
              className="preview-nav left"
              title="Previous (←)"
              aria-label="Previous asset"
              onClick={() => onNavigate(-1)}
            >
              ‹
            </button>
            <button
              className="preview-nav right"
              title="Next (→)"
              aria-label="Next asset"
              onClick={() => onNavigate(1)}
            >
              ›
            </button>
          </>
        )}

        <div className="stage-inner" key={asset.id}>
          {asset.kind === "image" &&
            (imgUrl ? (
              <img src={imgUrl} alt={asset.name} decoding="async" />
            ) : (
              <span className="spinner stage-spinner" />
            ))}
          {asset.kind === "video" && (
            <video src={originalUrl!} controls autoPlay={false} preload="metadata" />
          )}
          {asset.kind === "audio" && (
            <div className="audio-card">
              <div className="glyph">🎵</div>
              <audio src={originalUrl!} controls />
            </div>
          )}
          {asset.kind === "pdf" && (
            <iframe className="pdf-frame" src={originalUrl!} title={asset.name} />
          )}
          {asset.kind === "other" && (
            <div className="audio-card">
              <div className="glyph">📎</div>
              <div style={{ color: "var(--text-dim)" }}>
                No inline preview for this file type.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="preview-info">
        {renaming ? (
          <input
            className="rename-input rename-input-lg"
            value={nameValue}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                skipBlur.current = true;
                commitRename();
              } else if (e.key === "Escape") {
                skipBlur.current = true;
                setRenaming(false);
              }
            }}
            onBlur={() => {
              if (skipBlur.current) {
                skipBlur.current = false;
                return;
              }
              commitRename();
            }}
          />
        ) : (
          <span
            className="name"
            title={`${asset.path}\n(double-click to rename)`}
            onDoubleClick={() => {
              setNameValue(asset.name);
              setRenaming(true);
            }}
          >
            {asset.name}
          </span>
        )}
        <span className="meta">{fmtDate(asset.captureTs)}</span>
        <span className="meta">{humanSize(asset.size)}</span>
        {asset.ext && <span className="meta">{asset.ext.toUpperCase()}</span>}
        <span className="grow" />
        {position && (
          <span className="meta preview-pos">
            {position.index + 1} of {position.total.toLocaleString()}
          </span>
        )}
        <button
          className={`btn icon star-btn ${asset.favorite ? "on" : ""}`}
          title={asset.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label="Toggle favorite"
          onClick={() => onToggleFavorite(asset)}
        >
          {asset.favorite ? "★" : "☆"}
        </button>
        <button
          className="btn"
          title="Copy full path"
          onClick={() => navigator.clipboard?.writeText(asset.path)}
        >
          Copy path
        </button>
        <button className="btn" onClick={() => revealInFinder(asset.path)}>
          Reveal in Finder
        </button>
        <button className="btn danger" onClick={() => onDelete(asset)}>
          Delete
        </button>
      </div>
    </div>
  );
}
