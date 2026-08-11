import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
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
 * The calendar is rendered in a portal and positioned as a fixed overlay, so it
 * floats above everything (never clipped by a scrolling parent) and doesn't
 * push the surrounding layout around. The caption shows only the month name.
 */
export function MonthDayPicker({ value, onChange, placeholder = "Pick a date" }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  // Position the floating panel relative to the trigger, flipping up / clamping
  // to the viewport as needed. Runs before paint to avoid a flash.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + p.height > window.innerHeight - 8) {
      top = Math.max(8, r.top - p.height - 6);
    }
    let left = r.left;
    if (left + p.width > window.innerWidth - 8) {
      left = window.innerWidth - p.width - 8;
    }
    setStyle({ position: "fixed", left: Math.max(8, left), top, zIndex: 300 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("resize", close);
    // Close on scroll of any ancestor (capture) so the panel never drifts.
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const selected = value ? new Date(REF_YEAR, value.month - 1, value.day) : undefined;
  const label = value ? `${MONTHS[value.month - 1]} ${value.day}` : placeholder;

  const openPicker = () => {
    setStyle({ visibility: "hidden" }); // re-measure on next open
    setOpen((o) => !o);
  };

  return (
    <div className="mdp">
      <button
        type="button"
        ref={triggerRef}
        className={`date-chip mdp-trigger ${value ? "active" : ""}`}
        onClick={openPicker}
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

      {open &&
        createPortal(
          <div
            className="mdp-panel"
            ref={panelRef}
            role="dialog"
            aria-label="Pick a day"
            style={style}
          >
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
          </div>,
          document.body
        )}
    </div>
  );
}
