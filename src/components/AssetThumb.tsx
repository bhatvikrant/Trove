import { useEffect, useState } from "react";
import { getThumb } from "../api";
import type { Asset, Kind } from "../types";

const FALLBACK: Record<Kind, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  pdf: "📄",
  other: "📎",
};

// Small in-memory cache so re-rendered rows don't re-request thumbnails.
// A `null` entry means "resolved, but this asset has no thumbnail".
const cache = new Map<string, string | null>();

export function AssetThumb({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(() =>
    cache.has(asset.path) ? cache.get(asset.path)! : null
  );
  // Distinguish "still loading" from "resolved, no thumbnail" so we don't flash
  // the emoji fallback for a frame before the image paints.
  const [resolved, setResolved] = useState(() => cache.has(asset.path));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (cache.has(asset.path)) {
      setUrl(cache.get(asset.path)!);
      setResolved(true);
      return;
    }
    setResolved(false);
    setFailed(false);
    getThumb(asset.path, 128)
      .then((u) => {
        cache.set(asset.path, u);
        if (alive) {
          setUrl(u);
          setResolved(true);
        }
      })
      .catch(() => {
        cache.set(asset.path, null);
        if (alive) {
          setUrl(null);
          setResolved(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [asset.path]);

  if (url && !failed) {
    return (
      <span className="asset-thumb">
        <img src={url} loading="lazy" onError={() => setFailed(true)} alt="" />
      </span>
    );
  }
  // While loading, render just the neutral box (no emoji) to avoid a flash;
  // only show the kind glyph once we know there's no thumbnail.
  return (
    <span className="asset-thumb">
      {resolved ? FALLBACK[asset.kind] : ""}
    </span>
  );
}
