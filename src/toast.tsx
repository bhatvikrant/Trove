import { useSyncExternalStore } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: "info" | "success" | "error";
  action?: ToastAction;
  /** Auto-dismiss delay in ms. 0 keeps it until dismissed. Default 3000. */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: number;
  message: string;
}

const MAX_TOASTS = 4;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

function emit() {
  for (const l of listeners) l();
}

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** Show a transient toast. Returns its id so callers can dismiss it early. */
export function showToast(message: string, opts: ToastOptions = {}): number {
  const id = nextId++;
  toasts = [...toasts, { id, message, ...opts }];
  // Keep the stack shallow: drop the oldest when it grows past the cap.
  while (toasts.length > MAX_TOASTS) {
    const dropped = toasts[0];
    toasts = toasts.slice(1);
    clearTimer(dropped.id);
  }
  emit();
  const duration = opts.duration ?? 3000;
  if (duration > 0) {
    timers.set(id, window.setTimeout(() => dismissToast(id), duration));
  }
  return id;
}

export function dismissToast(id: number) {
  clearTimer(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot() {
  return toasts;
}

/** Renders the active toast stack. Mount once, near the app root. */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  if (items.length === 0) return null;
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind ?? "info"}`} role="status">
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
