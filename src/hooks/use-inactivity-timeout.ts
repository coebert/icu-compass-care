import { useEffect, useRef } from "react";

/**
 * Auto sign-out on inactivity.
 *
 * Watches real user interaction (pointer, keyboard, scroll, touch) and fires
 * `onTimeout` after `timeoutMs` of no activity, with an optional `onWarn`
 * callback fired `warnMs` before the timeout so the UI can warn the user.
 *
 * Activity is shared across tabs via a single localStorage key so that:
 *  - interacting in one tab keeps every other tab alive, and
 *  - the timer reflects the most recent activity in ANY tab.
 *
 * The actual sign-out (clearing caches, `supabase.auth.signOut()`, redirect to
 * /auth) is left to the caller's `onTimeout` handler. Sign-out in one tab
 * propagates to the others through Supabase's `onAuthStateChange` (wired in the
 * root route), which reruns the protected-route gate and redirects to /auth.
 */

const ACTIVITY_KEY = "icu:last-activity";

// Only persist activity at most once per second to avoid hammering
// localStorage on continuous events like mousemove/scroll.
const WRITE_THROTTLE_MS = 1000;

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
  "wheel",
] as const;

type Options = {
  /** Idle time before sign-out, in milliseconds. */
  timeoutMs: number;
  /** How long before the timeout to fire `onWarn`. Set 0 to disable. */
  warnMs?: number;
  onTimeout: () => void;
  onWarn?: () => void;
  /** When false the watcher is inert (e.g. while signed out). */
  enabled?: boolean;
};

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
  } catch {
    return Date.now();
  }
}

export function useInactivityTimeout({
  timeoutMs,
  warnMs = 60_000,
  onTimeout,
  onWarn,
  enabled = true,
}: Options) {
  const onTimeoutRef = useRef(onTimeout);
  const onWarnRef = useRef(onWarn);
  onTimeoutRef.current = onTimeout;
  onWarnRef.current = onWarn;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let warned = false;
    let fired = false;
    let lastWrite = 0;

    const markActive = (ts = Date.now()) => {
      warned = false;
      try {
        localStorage.setItem(ACTIVITY_KEY, String(ts));
      } catch {
        /* storage unavailable — fall back to in-memory timing */
      }
    };

    // Seed the timer with "now" so a freshly loaded session starts fresh.
    markActive();

    const handleActivity = () => {
      if (fired || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastWrite < WRITE_THROTTLE_MS) {
        warned = false;
        return;
      }
      lastWrite = now;
      markActive(now);
    };

    // Activity in another tab (or a sign-out clearing storage) resets the warn
    // flag here too, keeping every tab in sync.
    const handleStorage = (e: StorageEvent) => {
      if (e.key === ACTIVITY_KEY || e.key === null) warned = false;
    };

    ACTIVITY_EVENTS.forEach((evt) =>
      window.addEventListener(evt, handleActivity, { passive: true }),
    );
    window.addEventListener("storage", handleStorage);

    const interval = window.setInterval(() => {
      if (fired) return;
      const idle = Date.now() - readLastActivity();
      if (idle >= timeoutMs) {
        fired = true;
        onTimeoutRef.current();
      } else if (warnMs > 0 && idle >= timeoutMs - warnMs && !warned) {
        warned = true;
        onWarnRef.current?.();
      }
    }, 1000);

    return () => {
      ACTIVITY_EVENTS.forEach((evt) =>
        window.removeEventListener(evt, handleActivity),
      );
      window.removeEventListener("storage", handleStorage);
      window.clearInterval(interval);
    };
  }, [enabled, timeoutMs, warnMs]);
}
