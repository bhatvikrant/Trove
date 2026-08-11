import { useEffect, useRef, useState } from "react";
import { getSettings, setStoreInFolder, setVisionQuality } from "../api";
import type { VisionQuality } from "../types";
import { showToast } from "../toast";

type SectionId = "analysis" | "storage";

const SECTIONS: { id: SectionId; label: string; icon: JSX.Element }[] = [
  {
    id: "analysis",
    label: "Photo analysis",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
        <path d="M18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
      </svg>
    ),
  },
  {
    id: "storage",
    label: "Portable data",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
  },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("analysis");
  // `null` until the saved setting loads, so we don't flash a default.
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
      ?.querySelector<HTMLElement>("input, button, [tabindex]")
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

  const QUALITY_OPTIONS: { id: VisionQuality; title: string; sub: string }[] = [
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
        className="modal settings-modal"
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

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item ${section === s.id ? "active" : ""}`}
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {section === "analysis" && (
              <section className="set-sec">
                <h3 className="set-panel-title">Photo analysis</h3>
                <p className="set-desc">
                  Trove scans photos for scene labels and text (OCR). Choose how
                  thorough the text recognition is.
                </p>
                <div className="set-options">
                  {QUALITY_OPTIONS.map((o) => (
                    <label
                      key={o.id}
                      className={`set-opt ${quality === o.id ? "on" : ""}`}
                    >
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
            )}

            {section === "storage" && (
              <section className="set-sec">
                <h3 className="set-panel-title">Portable folder data</h3>
                <p className="set-desc">
                  Store favorites, people names, and analysis results in a
                  hidden <code>.trove</code> folder inside your media folder. The
                  folder then carries its own data — open it on another Mac and
                  everything is restored, with no re-analysis of unchanged
                  photos.
                </p>
                <label
                  className={`set-toggle ${storeInFolder ? "on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={!!storeInFolder}
                    disabled={storeInFolder === null}
                    onChange={(e) => toggleStore(e.target.checked)}
                  />
                  <span className="set-opt-body">
                    <span className="set-opt-title">
                      Store data inside the folder
                    </span>
                    <span className="set-opt-sub">
                      Off keeps everything on this Mac only. Names travel with
                      the folder, so sharing it shares who you've tagged.
                    </span>
                  </span>
                </label>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
