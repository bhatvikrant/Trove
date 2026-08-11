import { useEffect, useMemo, useRef, useState } from "react";
import { DayPicker, type DateRange as RdpRange } from "react-day-picker";
import "react-day-picker/style.css";
import {
  endOfMonth,
  endOfYear,
  format,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subYears,
} from "date-fns";
import type { DateRange } from "../types";

interface Props {
  range: DateRange;
  onChange: (r: DateRange) => void;
}

const toKey = (d: Date) => format(d, "yyyy-MM-dd");
const fromKey = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

interface Preset {
  label: string;
  get: () => DateRange;
}

function buildPresets(now: Date): Preset[] {
  const today = toKey(now);
  return [
    { label: "All time", get: () => ({ start: null, end: null }) },
    { label: "Today", get: () => ({ start: today, end: today }) },
    {
      label: "Yesterday",
      get: () => {
        const y = toKey(subDays(now, 1));
        return { start: y, end: y };
      },
    },
    {
      label: "Last 7 days",
      get: () => ({ start: toKey(subDays(now, 6)), end: today }),
    },
    {
      label: "Last 30 days",
      get: () => ({ start: toKey(subDays(now, 29)), end: today }),
    },
    {
      label: "This month",
      get: () => ({ start: toKey(startOfMonth(now)), end: today }),
    },
    {
      label: "Last month",
      get: () => {
        const lm = subMonths(now, 1);
        return { start: toKey(startOfMonth(lm)), end: toKey(endOfMonth(lm)) };
      },
    },
    {
      label: "This year",
      get: () => ({ start: toKey(startOfYear(now)), end: today }),
    },
    {
      label: "Last year",
      get: () => {
        const ly = subYears(now, 1);
        return { start: toKey(startOfYear(ly)), end: toKey(endOfYear(ly)) };
      },
    },
  ];
}

function rangesEqual(a: DateRange, b: DateRange) {
  return a.start === b.start && a.end === b.end;
}

function labelFor(range: DateRange, presets: Preset[]): string {
  if (!range.start && !range.end) return "All time";
  const match = presets.find((p) => rangesEqual(p.get(), range));
  if (match) return match.label;
  if (range.start && range.end) {
    if (range.start === range.end) return format(fromKey(range.start), "MMM d, yyyy");
    return `${format(fromKey(range.start), "MMM d")} – ${format(
      fromKey(range.end),
      "MMM d, yyyy"
    )}`;
  }
  if (range.start) return `Since ${format(fromKey(range.start), "MMM d, yyyy")}`;
  return `Until ${format(fromKey(range.end!), "MMM d, yyyy")}`;
}

export function CalendarPicker({ range, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // `now` is captured once per mount so preset ranges stay stable.
  const now = useMemo(() => new Date(), []);
  const presets = useMemo(() => buildPresets(now), [now]);

  const rdpSelected: RdpRange | undefined = useMemo(() => {
    if (!range.start && !range.end) return undefined;
    return {
      from: range.start ? fromKey(range.start) : undefined,
      to: range.end ? fromKey(range.end) : undefined,
    };
  }, [range]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const active = !!(range.start || range.end);
  const label = labelFor(range, presets);

  const handleRdpSelect = (r: RdpRange | undefined) => {
    if (!r || (!r.from && !r.to)) {
      onChange({ start: null, end: null });
      return;
    }
    onChange({
      start: r.from ? toKey(r.from) : null,
      end: r.to ? toKey(r.to) : r.from ? toKey(r.from) : null,
    });
  };

  return (
    <div className="date-picker" ref={ref}>
      <button
        className={`date-chip ${active ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>🗓️</span>
        <span>{label}</span>
        <svg className="chip-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="date-popover">
          <div className="date-presets">
            {presets.map((p) => {
              const isActive = rangesEqual(p.get(), range);
              return (
                <button
                  key={p.label}
                  className={`preset-btn ${isActive ? "active" : ""}`}
                  onClick={() => {
                    onChange(p.get());
                    if (p.label !== "All time") setOpen(false);
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div>
            <div className="date-cal">
              <DayPicker
                mode="range"
                numberOfMonths={2}
                selected={rdpSelected}
                onSelect={handleRdpSelect}
                defaultMonth={
                  range.end ? fromKey(range.end) : subMonths(now, 1)
                }
                captionLayout="dropdown"
                startMonth={new Date(1990, 0)}
                endMonth={now}
              />
            </div>
            <div className="date-cal-footer">
              <span className="date-range-label">{label}</span>
              <button
                className="btn"
                onClick={() => onChange({ start: null, end: null })}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
