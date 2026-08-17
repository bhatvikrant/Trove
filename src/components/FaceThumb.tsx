import { useEffect, useState } from "react";
import { faceThumbKey, peekThumb, requestFaceThumb } from "../thumbQueue";
import type { FaceBox } from "../types";

export function FaceThumb({
  path,
  box,
  size = 96,
}: {
  path: string;
  box: FaceBox;
  size?: number;
}) {
  const key = faceThumbKey(path, box, size);
  const [url, setUrl] = useState<string | null>(() => peekThumb(key) ?? null);

  useEffect(() => {
    const hit = peekThumb(key);
    if (hit !== undefined) {
      setUrl(hit);
      return;
    }
    setUrl(null);
    return requestFaceThumb(path, box, size, setUrl);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className="face-thumb">
      {url ? <img src={url} loading="lazy" alt="" draggable={false} /> : "🙂"}
    </span>
  );
}
