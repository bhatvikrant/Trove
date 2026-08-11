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
const cache = new Map<string, string | null>();

export function AssetThumb({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(() =>
    cache.has(asset.path) ? cache.get(asset.path)! : null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (cache.has(asset.path)) {
      setUrl(cache.get(asset.path)!);
      return;
    }
    getThumb(asset.path, 128)
      .then((u) => {
        cache.set(asset.path, u);
        if (alive) setUrl(u);
      })
      .catch(() => {
        cache.set(asset.path, null);
        if (alive) setUrl(null);
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
  return <span className="asset-thumb">{FALLBACK[asset.kind]}</span>;
}
