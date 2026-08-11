import { useEffect, useRef, useState } from "react";
import { getSettings, setVisionQuality } from "../api";
import type { VisionQuality } from "../types";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [quality, setQuality] = useState<VisionQuality>("accurate");
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setQuality(s.visionQuality))
      .catch(() => {});
  }, []);

  // Move focus into the dialog on open and restore it to the trigger on close.
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    modalRef.current
      ?.querySelector<HTMLElement>('input, button, [tabindex]')
      ?.focus();
    return () => prevFocused?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Trap Tab within the dialog.
      if (e.key !== "Tab" || !modalRef.current) return;
      const focusables = modalRef.current.querySelectorAll<HTMLElement>(
        'input, button, [href], [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="settings-title">Settings</h2>
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
