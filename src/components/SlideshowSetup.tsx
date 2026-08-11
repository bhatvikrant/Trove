import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  countSlideshowAssets,
  deleteSlideshowPreset,
  getFaceThumb,
  getPeople,
  listSlideshowPresets,
  saveSlideshowPreset,
} from "../api";
import {
  DEFAULT_SLIDESHOW_CONFIG,
  type Kind,
  type Person,
  type SlideshowConfig,
  type SlideshowPreset,
  type SpecialDate,
} from "../types";
import { showToast } from "../toast";

const KINDS: { id: Kind; label: string }[] = [
  { id: "image", label: "Photos" },
  { id: "video", label: "Videos" },
  { id: "pdf", label: "PDFs" },
  { id: "audio", label: "Audio" },
];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function PersonChip({
  person,
  selected,
  onToggle,
}: {
  person: Person;
  selected: boolean;
  onToggle: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getFaceThumb(person.path, { x: person.x, y: person.y, w: person.w, h: person.h }, 72)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [person]);
  return (
    <button
      className={`ss-person ${selected ? "on" : ""}`}
      onClick={onToggle}
      title={person.name ?? "Unnamed"}
      aria-pressed={selected}
    >
      <span className="ss-person-face">
        {url ? <img src={url} alt="" /> : "🙂"}
      </span>
      <span className="ss-person-name">{person.name ?? "Unnamed"}</span>
    </button>
  );
}

interface Props {
  onClose: () => void;
  onStart: (config: SlideshowConfig) => void;
  initial?: SlideshowConfig;
}

export function SlideshowSetup({ onClose, onStart, initial }: Props) {
  const [config, setConfig] = useState<SlideshowConfig>(
    initial ?? DEFAULT_SLIDESHOW_CONFIG
  );
  const [people, setPeople] = useState<Person[]>([]);
  const [presets, setPresets] = useState<SlideshowPreset[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [dateInput, setDateInput] = useState("");

  const set = useCallback(
    (patch: Partial<SlideshowConfig>) => setConfig((c) => ({ ...c, ...patch })),
    []
  );

  useEffect(() => {
    getPeople().then((p) => setPeople(p.filter((x) => x.name))).catch(() => {});
    listSlideshowPresets().then(setPresets).catch(() => {});
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Debounced live count of matching media.
  useEffect(() => {
    setCounting(true);
    const t = window.setTimeout(() => {
      countSlideshowAssets(config)
        .then((n) => setCount(n))
        .catch(() => setCount(null))
        .finally(() => setCounting(false));
    }, 250);
    return () => clearTimeout(t);
  }, [config]);

  const addDate = () => {
    if (!dateInput) return;
    const [, m, d] = dateInput.split("-").map(Number);
    if (!m || !d) return;
    const exists = config.specialDates.some((x) => x.month === m && x.day === d);
    if (!exists) {
      set({ specialDates: [...config.specialDates, { month: m, day: d }] });
    }
    setDateInput("");
  };

  const removeDate = (sd: SpecialDate) =>
    set({
      specialDates: config.specialDates.filter(
        (x) => !(x.month === sd.month && x.day === sd.day)
      ),
    });

  const loadPreset = (p: SlideshowPreset) => {
    try {
      setConfig({ ...DEFAULT_SLIDESHOW_CONFIG, ...JSON.parse(p.config) });
      showToast(`Loaded “${p.name}”`);
    } catch {
      showToast("Couldn’t load preset", { kind: "error" });
    }
  };

  const savePreset = async () => {
    const name = window.prompt("Save this slideshow as:");
    if (!name?.trim()) return;
    try {
      const saved = await saveSlideshowPreset(name.trim(), config);
      setPresets((ps) => [saved, ...ps]);
      showToast(`Saved “${saved.name}”`, { kind: "success" });
    } catch {
      showToast("Couldn’t save preset", { kind: "error" });
    }
  };

  const removePreset = async (p: SlideshowPreset) => {
    try {
      await deleteSlideshowPreset(p.id);
      setPresets((ps) => ps.filter((x) => x.id !== p.id));
    } catch {
      /* ignore */
    }
  };

  const canStart = (count ?? 0) > 0;
  const dateInputRef = useRef<HTMLInputElement>(null);

  const countLabel = useMemo(() => {
    if (counting && count === null) return "Counting…";
    if (count === null) return "—";
    return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
  }, [count, counting]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal ss-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ss-setup-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="ss-setup-title">Slideshow</h2>
          <button className="btn icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body ss-setup-body">
          {/* Media types */}
          <section className="ss-sec">
            <h4>Media</h4>
            <div className="chk-row">
              {KINDS.map((k) => (
                <label key={k.id} className={`chk ${config.kinds.includes(k.id) ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={config.kinds.includes(k.id)}
                    onChange={() => set({ kinds: toggle(config.kinds, k.id) })}
                  />
                  {k.label}
                </label>
              ))}
              <label className={`chk ${config.favoriteOnly ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={config.favoriteOnly}
                  onChange={() => set({ favoriteOnly: !config.favoriteOnly })}
                />
                ⭐ Favorites
              </label>
            </div>
            <p className="ss-hint">Leave media unchecked to include everything.</p>
          </section>

          {/* Special dates */}
          <section className="ss-sec">
            <h4>Special dates</h4>
            <div className="ss-date-add">
              <input
                ref={dateInputRef}
                type="date"
                className="sidebar-search ss-date-input"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addDate()}
              />
              <button className="btn" onClick={addDate} disabled={!dateInput}>
                Add
              </button>
            </div>
            {config.specialDates.length > 0 && (
              <>
                <div className="ss-chips">
                  {config.specialDates.map((sd) => (
                    <span key={`${sd.month}-${sd.day}`} className="fc-chip">
                      🎂 {MONTHS[sd.month - 1]} {sd.day}
                      <button aria-label="Remove date" onClick={() => removeDate(sd)}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <label className="ss-window">
                  ± days
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={config.windowDays}
                    onChange={(e) =>
                      set({ windowDays: Math.max(0, Math.min(30, +e.target.value || 0)) })
                    }
                  />
                  <span className="ss-hint">
                    matches these days every year{config.windowDays > 0 ? ", within the window" : ""}
                  </span>
                </label>
              </>
            )}
          </section>

          {/* People */}
          {people.length > 0 && (
            <section className="ss-sec">
              <h4>People</h4>
              <div className="ss-people">
                {people.map((p) => (
                  <PersonChip
                    key={p.clusterId}
                    person={p}
                    selected={config.personClusterIds.includes(p.clusterId)}
                    onToggle={() =>
                      set({
                        personClusterIds: toggle(config.personClusterIds, p.clusterId),
                      })
                    }
                  />
                ))}
              </div>
              <p className="ss-hint">Any selected person appearing qualifies a photo.</p>
            </section>
          )}

          {/* Playback */}
          <section className="ss-sec">
            <h4>Playback</h4>
            <label className="ss-window">
              Seconds per slide
              <input
                type="number"
                min={1}
                max={60}
                value={config.durationSec}
                onChange={(e) =>
                  set({ durationSec: Math.max(1, Math.min(60, +e.target.value || 5)) })
                }
              />
            </label>
            <div className="chk-row ss-toggles">
              {([
                ["shuffle", "Shuffle"],
                ["loop", "Loop"],
                ["crossfade", "Crossfade"],
                ["kenBurns", "Ken Burns"],
                ["captions", "Captions"],
                ["muteVideo", "Mute video"],
              ] as [keyof SlideshowConfig, string][]).map(([key, label]) => (
                <label key={key} className={`chk ${config[key] ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={!!config[key]}
                    onChange={() => set({ [key]: !config[key] } as Partial<SlideshowConfig>)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </section>

          {/* Presets */}
          {presets.length > 0 && (
            <section className="ss-sec">
              <h4>Saved</h4>
              <div className="ss-chips">
                {presets.map((p) => (
                  <span key={p.id} className="fc-chip ss-preset">
                    <button className="ss-preset-load" onClick={() => loadPreset(p)}>
                      {p.name}
                    </button>
                    <button aria-label="Delete preset" onClick={() => removePreset(p)}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="ss-setup-foot">
          <span className="ss-count-label">{countLabel}</span>
          <span className="grow" />
          <button className="btn" onClick={savePreset}>
            Save…
          </button>
          <button
            className="btn primary"
            disabled={!canStart}
            onClick={() => onStart(config)}
          >
            ▶ Start
          </button>
        </div>
      </div>
    </div>
  );
}
