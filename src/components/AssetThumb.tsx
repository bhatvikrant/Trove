import { useEffect, useState } from "react";
import { assetThumbKey, peekThumb, requestAssetThumb } from "../thumbQueue";
import type { Asset, Kind } from "../types";

const FALLBACK: Record<Kind, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  pdf: "📄",
  other: "📎",
};

const SIZE = 128;

export function AssetThumb({ asset }: { asset: Asset }) {
  // Generation is queued (see thumbQueue) so a fast scroll can't stampede the
  // machine; a row that scrolls away before its turn takes itself back out.
  const [url, setUrl] = useState<string | null>(
    () => peekThumb(assetThumbKey(asset.path, SIZE)) ?? null
  );
  // Distinguish "still loading" from "resolved, no thumbnail" so we don't flash
  // the emoji fallback for a frame before the image paints.
  const [resolved, setResolved] = useState(
    () => peekThumb(assetThumbKey(asset.path, SIZE)) !== undefined
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hit = peekThumb(assetThumbKey(asset.path, SIZE));
    setFailed(false);
    if (hit !== undefined) {
      setUrl(hit);
      setResolved(true);
      return;
    }
    setUrl(null);
    setResolved(false);
    return requestAssetThumb(asset.path, SIZE, (u) => {
      setUrl(u);
      setResolved(true);
    });
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
