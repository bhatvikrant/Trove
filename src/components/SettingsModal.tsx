import { useEffect, useRef, useState } from "react";
import { getSettings, setStoreInFolder, setVisionQuality } from "../api";
import type { VisionQuality } from "../types";
import { showToast } from "../toast";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  // `null` until the saved setting loads, so we don't flash the first option
  // as selected and then jump to the real one.
  const [quality, setQuality] = useState<VisionQuality | null>(null);
  const [storeInFolder, setStoreInFolderState] = useState<boolean | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setQuality(s.visionQuality);
        setStoreInFolderState(s.storeInFolder);
      })
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
    showToast(
      q === "fast" ? "Analysis set to Fast" : "Analysis set to Best accuracy",
      { kind: "success" }
    );
  };

  const toggleStore = (next: boolean) => {
    setStoreInFolderState(next);
    setStoreInFolder(next).catch(() => {});
    showToast(
      next
        ? "Trove will store its data inside the folder"
        : "Trove will keep its data on this Mac only",
      { kind: "success" }
    );
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

          <section className="set-sec">
            <h3>Portable folder data</h3>
            <p className="set-desc">
              Store favorites, people names, and analysis results in a hidden{" "}
              <code>.trove</code> folder inside your media folder. The folder
              then carries its own data — open it on another Mac and everything
              is restored, with no re-analysis of unchanged photos.
            </p>
            <label className={`set-toggle ${storeInFolder ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={!!storeInFolder}
                disabled={storeInFolder === null}
                onChange={(e) => toggleStore(e.target.checked)}
              />
              <span className="set-opt-body">
                <span className="set-opt-title">Store data inside the folder</span>
                <span className="set-opt-sub">
                  Off keeps everything on this Mac only. Names travel with the
                  folder, so sharing it shares who you've tagged.
                </span>
              </span>
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
