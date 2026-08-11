import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { format } from "date-fns";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// A leap year so Feb 29 is selectable; only month/day are ever read back.
const REF_YEAR = 2020;

interface Props {
  value: { month: number; day: number } | null;
  onChange: (month: number, day: number) => void;
  placeholder?: string;
}

/**
 * A pretty calendar picker for a recurring day (month + day, year irrelevant).
 * The calendar expands inline below the trigger so it can't be clipped by a
 * scrolling parent, and the caption shows only the month name.
 */
export function MonthDayPicker({ value, onChange, placeholder = "Pick a date" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const selected = value ? new Date(REF_YEAR, value.month - 1, value.day) : undefined;
  const label = value ? `${MONTHS[value.month - 1]} ${value.day}` : placeholder;

  return (
    <div className="mdp" ref={ref}>
      <button
        type="button"
        className={`date-chip mdp-trigger ${value ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M3 9h18M8 2v4M16 2v4" />
        </svg>
        <span>{label}</span>
        <svg className="chip-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="mdp-panel" role="dialog" aria-label="Pick a day">
          <DayPicker
            mode="single"
            selected={selected}
            defaultMonth={selected ?? new Date(REF_YEAR, 0)}
            onSelect={(d) => {
              if (d) {
                onChange(d.getMonth() + 1, d.getDate());
                setOpen(false);
              }
            }}
            captionLayout="label"
            formatters={{ formatCaption: (date) => format(date, "MMMM") }}
          />
        </div>
      )}
    </div>
  );
}
