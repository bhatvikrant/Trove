import { useEffect, useRef, useState } from "react";
import {
  getSettings,
  resetApp,
  resetFeature,
  resetFolder,
  setStoreInFolder,
  setVisionQuality,
} from "../api";
import type { ResettableFeature } from "../api";
import type { VisionQuality } from "../types";
import { showToast } from "../toast";

type SectionId = "analysis" | "storage" | "danger";

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
  {
    id: "danger",
    label: "Danger zone",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    ),
  },
];

export function SettingsModal({
  onClose,
  root,
  onFolderReset,
  onFeatureReset,
  onAppReset,
}: {
  onClose: () => void;
  /** The currently open folder (absolute path), or null on the welcome screen. */
  root: string | null;
  /** Called after the open folder's Trove data has been reset. */
  onFolderReset: () => void;
  /** Called after a single feature's data has been reset. */
  onFeatureReset: (feature: ResettableFeature) => void;
  /** Called after app-wide settings/data have been reset to defaults. */
  onAppReset: () => void;
}) {
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
                className={`settings-nav-item ${s.id === "danger" ? "danger" : ""} ${section === s.id ? "active" : ""}`}
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

            {section === "danger" && (
              <section className="set-sec">
                <h3 className="set-panel-title danger-title">Danger zone</h3>
                <p className="set-desc">
                  These actions permanently discard Trove data. They never delete
                  or move your photos, videos, or other files.
                </p>

                <h4 className="danger-group-title">Reset a feature</h4>

                <DangerAction
                  title="Face names"
                  description="Names you’ve given the people Trove found"
                  buttonLabel="Reset…"
                  warning={
                    <>
                      Clears <strong>every name</strong> you’ve assigned to people,
                      across all folders. The detected faces themselves stay, so
                      you can name them again.
                    </>
                  }
                  onConfirm={async () => {
                    await resetFeature("faces");
                    showToast("Cleared all face names", { kind: "success" });
                    onFeatureReset("faces");
                  }}
                />

                <DangerAction
                  title="Favorites"
                  description="Everything you’ve starred"
                  buttonLabel="Reset…"
                  warning={
                    <>
                      Removes the star from <strong>every favorited item</strong>,
                      across all folders.
                    </>
                  }
                  onConfirm={async () => {
                    await resetFeature("favorites");
                    showToast("Cleared all favorites", { kind: "success" });
                    onFeatureReset("favorites");
                  }}
                />

                <DangerAction
                  title="Occasions"
                  description="Saved recurring dates in the Occasions tab"
                  buttonLabel="Reset…"
                  warning={
                    <>Deletes <strong>all saved occasions</strong>.</>
                  }
                  onConfirm={async () => {
                    await resetFeature("occasions");
                    showToast("Deleted all occasions", { kind: "success" });
                    onFeatureReset("occasions");
                  }}
                />

                <DangerAction
                  title="Saved slideshows"
                  description="Slideshow presets you’ve saved"
                  buttonLabel="Reset…"
                  warning={
                    <>Deletes <strong>all saved slideshow presets</strong>.</>
                  }
                  onConfirm={async () => {
                    await resetFeature("slideshows");
                    showToast("Deleted all saved slideshows", {
                      kind: "success",
                    });
                    onFeatureReset("slideshows");
                  }}
                />

                <DangerAction
                  title="Recent folders"
                  description="The list on the welcome screen"
                  buttonLabel="Reset…"
                  warning={
                    <>
                      Clears the <strong>recently-opened folders</strong> list. The
                      folders and their data are untouched.
                    </>
                  }
                  onConfirm={async () => {
                    await resetFeature("recents");
                    showToast("Cleared recent folders", { kind: "success" });
                    onFeatureReset("recents");
                  }}
                />

                <h4 className="danger-group-title">Reset everything</h4>

                <DangerAction
                  title="Reset this folder"
                  buttonLabel="Reset this folder…"
                  disabled={!root}
                  disabledNote="Open a folder first to reset its Trove data."
                  confirmWord={root ? folderName(root) : ""}
                  confirmHint={
                    root ? (
                      <>
                        Type <code>{folderName(root)}</code> to confirm.
                      </>
                    ) : null
                  }
                  warning={
                    <>
                      Removes Trove’s data for{" "}
                      <strong>{root ? folderName(root) : "this folder"}</strong>:
                      its favorites, the people names you’ve set, the hidden{" "}
                      <code>.trove</code> folder, and cached analysis. Trove then
                      re-scans and re-analyzes the folder from scratch. Your files
                      are not touched.
                    </>
                  }
                  onConfirm={async () => {
                    await resetFolder();
                    showToast("Reset this folder’s Trove data", {
                      kind: "success",
                    });
                    onFolderReset();
                    onClose();
                  }}
                />

                <DangerAction
                  title="Reset Trove"
                  buttonLabel="Reset all settings…"
                  confirmWord="RESET"
                  confirmHint={
                    <>
                      Type <code>RESET</code> to confirm.
                    </>
                  }
                  warning={
                    <>
                      Restores all app-wide settings to their defaults and clears
                      your recent folders, saved slideshows, and saved occasions.
                      The current folder is closed. Your files and any in-folder{" "}
                      <code>.trove</code> data are left untouched.
                    </>
                  }
                  onConfirm={async () => {
                    await resetApp();
                    showToast("Trove reset to defaults", { kind: "success" });
                    onAppReset();
                    onClose();
                  }}
                />
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The folder's display name (last path segment) from an absolute path. */
function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * A destructive action behind a double confirmation. The danger button reveals
 * an inline warning; the user then confirms with a second, explicit click. When
 * a `confirmWord` is given (for the heaviest actions) the confirm button stays
 * disabled until the user types that word exactly.
 */
function DangerAction({
  title,
  description,
  buttonLabel,
  warning,
  confirmWord,
  confirmHint,
  onConfirm,
  disabled = false,
  disabledNote,
}: {
  title: string;
  description?: string;
  buttonLabel: string;
  warning: JSX.Element;
  confirmWord?: string;
  confirmHint?: JSX.Element | null;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
  disabledNote?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setConfirming(false);
    setTyped("");
  };

  useEffect(() => {
    if (confirming) inputRef.current?.focus();
  }, [confirming]);

  // With no confirmWord, the second explicit click is the confirmation.
  const matches = !confirmWord || typed.trim() === confirmWord;

  const run = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch (e) {
      showToast(String(e), { kind: "error" });
      setBusy(false);
      reset();
    }
  };

  return (
    <div className="danger-row">
      <div className="danger-row-head">
        <span className="danger-row-titles">
          <span className="danger-row-title">{title}</span>
          {description && (
            <span className="danger-row-desc">{description}</span>
          )}
        </span>
        {!confirming && (
          <button
            className="btn danger"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            {buttonLabel}
          </button>
        )}
      </div>
      {disabled && disabledNote && (
        <p className="danger-note">{disabledNote}</p>
      )}
      {confirming && (
        <div className="danger-confirm">
          <p className="danger-warning">{warning}</p>
          {confirmWord && (
            <>
              {confirmHint && <p className="danger-hint">{confirmHint}</p>}
              <input
                ref={inputRef}
                className="danger-input"
                type="text"
                value={typed}
                placeholder={confirmWord}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") run();
                  else if (e.key === "Escape") {
                    e.stopPropagation();
                    reset();
                  }
                }}
              />
            </>
          )}
          <div className="danger-actions">
            <button className="btn" disabled={busy} onClick={reset}>
              Cancel
            </button>
            <button
              className="btn danger solid"
              disabled={!matches || busy}
              onClick={run}
            >
              {busy ? "Resetting…" : buttonLabel.replace(/…$/, "")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
