import { useEffect, useState } from "react";
import { getSettings, setVisionQuality } from "../api";
import type { VisionQuality } from "../types";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [quality, setQuality] = useState<VisionQuality>("accurate");

  useEffect(() => {
    getSettings()
      .then((s) => setQuality(s.visionQuality))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const choose = (q: VisionQuality) => {
    if (q === quality) return;
    setQuality(q);
    setVisionQuality(q).catch(() => {});
  };

  const OPTIONS: { id: VisionQuality; title: string; sub: string }[] = [
    {
      id: "accurate",
      title: "Best accuracy",
      sub: "Most precise text recognition. Slower to analyze.",
    },
    {
      id: "fast",
      title: "Fast",
      sub: "Much quicker; may miss small or low-contrast text.",
    },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <section className="set-sec">
            <h3>Photo analysis</h3>
            <p className="set-desc">
              Trove scans photos for scene labels and text (OCR). Choose how
              thorough the text recognition is.
            </p>
            <div className="set-options">
              {OPTIONS.map((o) => (
                <label key={o.id} className={`set-opt ${quality === o.id ? "on" : ""}`}>
                  <input
                    type="radio"
                    name="vision-quality"
                    checked={quality === o.id}
                    onChange={() => choose(o.id)}
                  />
                  <span className="set-opt-body">
                    <span className="set-opt-title">{o.title}</span>
                    <span className="set-opt-sub">{o.sub}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="set-note">
              Changing this re-analyzes your photos in the background.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
