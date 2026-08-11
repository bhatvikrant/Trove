import { useEffect, useState } from "react";
import { getFaceThumb } from "../api";
import type { FaceBox } from "../types";

const cache = new Map<string, string | null>();

export function FaceThumb({
  path,
  box,
  size = 96,
}: {
  path: string;
  box: FaceBox;
  size?: number;
}) {
  const key = `${path}|${box.x.toFixed(3)},${box.y.toFixed(3)},${box.w.toFixed(3)},${box.h.toFixed(3)}|${size}`;
  const [url, setUrl] = useState<string | null>(() =>
    cache.has(key) ? cache.get(key)! : null
  );

  useEffect(() => {
    if (cache.has(key)) {
      setUrl(cache.get(key)!);
      return;
    }
    let alive = true;
    getFaceThumb(path, box, size)
      .then((u) => {
        cache.set(key, u);
        if (alive) setUrl(u);
      })
      .catch(() => {
        cache.set(key, null);
      });
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className="face-thumb">
      {url ? <img src={url} loading="lazy" alt="" draggable={false} /> : "🙂"}
    </span>
  );
}
