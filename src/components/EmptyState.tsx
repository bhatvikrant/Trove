import { useCallback, useEffect, useState } from "react";
import { getQuickLocations, getRecentFolders, removeRecent } from "../api";
import type { QuickLocations, RecentFolder } from "../types";

function timeAgo(unix: number): string {
  const s = Date.now() / 1000 - unix;
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

const KIND_ICON: Record<string, string> = {
  pictures: "🖼️",
  desktop: "🖥️",
  downloads: "⬇️",
  movies: "🎬",
  drive: "💾",
};

function Logo() {
  return (
    <svg width="64" height="64" viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id="troveGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
        <clipPath id="troveTile">
          <rect x="39" y="39" width="32" height="32" rx="7" />
        </clipPath>
      </defs>
      <rect x="4" y="4" width="88" height="88" rx="22" fill="url(#troveGrad)" />
      <rect x="25" y="29" width="32" height="32" rx="7" fill="#fff" opacity="0.45" />
      <rect x="39" y="39" width="32" height="32" rx="7" fill="#fff" />
      <g clipPath="url(#troveTile)">
        <circle cx="49" cy="48" r="4" fill="#f9a8d4" />
        <path d="M39 71l9-10 5 5 7-8 11 11v2H39z" fill="#d94fb0" opacity="0.6" />
      </g>
    </svg>
  );
}

interface Props {
  onPickFolder: () => void;
  onOpen: (path: string) => void;
  /** Bumped to re-fetch recents (e.g. after they're reset in Settings). */
  refreshToken?: number;
}

export function EmptyState({ onPickFolder, onOpen, refreshToken }: Props) {
  const [recents, setRecents] = useState<RecentFolder[]>([]);
  const [quick, setQuick] = useState<QuickLocations>({ standard: [], drives: [] });

  useEffect(() => {
    getRecentFolders().then(setRecents).catch(() => {});
    getQuickLocations().then(setQuick).catch(() => {});
  }, [refreshToken]);

  const handleRemove = useCallback(async (path: string) => {
    try {
      await removeRecent(path);
      setRecents((r) => r.filter((x) => x.path !== path));
    } catch {
      /* ignore */
    }
  }, []);

  const hasQuick = quick.standard.length > 0 || quick.drives.length > 0;

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <header className="welcome-hero">
          <Logo />
          <div>
            <h1>Trove</h1>
            <p className="welcome-tagline">
              Browse your photos, videos, audio &amp; PDFs by the date they were
              captured.
            </p>
          </div>
        </header>

        <div className="welcome-actions">
          <button className="btn primary" onClick={onPickFolder}>
            Choose Folder…
          </button>
          <span className="welcome-hint">
            or press <kbd>⌘O</kbd>, or drop a folder anywhere
          </span>
        </div>

        {recents.length > 0 && (
          <section className="welcome-section">
            <h2>Recent</h2>
            <div className="card-grid">
              {recents.map((r) => (
                <div
                  key={r.path}
                  className={`open-card ${r.exists ? "" : "disabled"}`}
                  onClick={() => r.exists && onOpen(r.path)}
                  title={r.path}
                >
                  <span className="open-card-ico">📁</span>
                  <span className="open-card-body">
                    <span className="open-card-name">{r.name}</span>
                    <span className="open-card-sub">
                      {r.exists
                        ? `${r.count != null ? `${r.count.toLocaleString()} assets · ` : ""}${timeAgo(r.lastOpened)}`
                        : "Unavailable"}
                    </span>
                  </span>
                  <button
                    className="open-card-remove"
                    title="Remove from recents"
                    aria-label="Remove from recents"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(r.path);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {hasQuick && (
          <section className="welcome-section">
            <h2>Quick access</h2>
            <div className="chip-row">
              {quick.standard.map((q) => (
                <button
                  key={q.path}
                  className="loc-chip"
                  onClick={() => onOpen(q.path)}
                  title={q.path}
                >
                  <span>{KIND_ICON[q.kind] ?? "📁"}</span>
                  {q.label}
                </button>
              ))}
            </div>
            {quick.drives.length > 0 && (
              <div className="chip-row" style={{ marginTop: 8 }}>
                {quick.drives.map((q) => (
                  <button
                    key={q.path}
                    className="loc-chip drive"
                    onClick={() => onOpen(q.path)}
                    title={q.path}
                  >
                    <span>💾</span>
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="welcome-features">
          <div className="feature">
            <span>🗂️</span> Date tree — year → month → day
          </div>
          <div className="feature">
            <span>🗓️</span> Filter by date range with smart presets
          </div>
          <div className="feature">
            <span>⌨️</span> Arrow-key navigation &amp; live preview
          </div>
          <div className="feature">
            <span>⚡</span> Handles tens of thousands of files
          </div>
        </section>
      </div>
    </div>
  );
}
