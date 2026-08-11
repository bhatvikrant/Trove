import { useMemo } from "react";
import { assetUrl, revealInFinder } from "../api";
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

interface Props {
  asset: Asset | null;
  total: number;
  position: { index: number; total: number } | null;
  onNavigate: (delta: number) => void;
}

export function PreviewPane({ asset, total, position, onNavigate }: Props) {
  const url = useMemo(() => (asset ? assetUrl(asset.path) : null), [asset]);
  const canCycle = !!position && position.total > 1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    // Let focused media controls handle arrow keys (scrubbing/volume).
    if (tag === "VIDEO" || tag === "AUDIO") return;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
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
        <div className="empty">
          <div className="glyph">👁️</div>
          <h2>Nothing selected</h2>
          <p>
            {total > 0
              ? `Pick an asset from the tree on the left to preview it here. ${total.toLocaleString()} assets in view.`
              : "Select an asset from the date tree to preview it."}
          </p>
        </div>
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
          {asset.kind === "image" && <img src={url!} alt={asset.name} />}
          {asset.kind === "video" && (
            <video src={url!} controls autoPlay={false} preload="metadata" />
          )}
          {asset.kind === "audio" && (
            <div className="audio-card">
              <div className="glyph">🎵</div>
              <audio src={url!} controls />
            </div>
          )}
          {asset.kind === "pdf" && (
            <iframe className="pdf-frame" src={url!} title={asset.name} />
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
        <span className="name" title={asset.path}>
          {asset.name}
        </span>
        <span className="meta">{fmtDate(asset.captureTs)}</span>
        <span className="meta">{humanSize(asset.size)}</span>
        {asset.ext && <span className="meta">{asset.ext.toUpperCase()}</span>}
        <span className="grow" />
        {position && (
          <span className="meta preview-pos">
            {position.index + 1} of {position.total.toLocaleString()}
          </span>
        )}
        <button className="btn" onClick={() => revealInFinder(asset.path)}>
          Reveal in Finder
        </button>
      </div>
    </div>
  );
}
