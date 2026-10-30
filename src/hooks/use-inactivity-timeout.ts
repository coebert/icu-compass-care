import { useEffect, useRef } from "react";

/**
 * Auto sign-out on inactivity (browser side).
 *
 * This is a convenience layer only. The authoritative idle limit is enforced
 * by the database (session_guard + private.session_active): once a session has
 * had no recorded activity for the limit, every role-gated request is refused
 * regardless of what this hook or browser storage says.
 *
 * Activity is shared across tabs via one localStorage key. Rules:
 *  - mounting / reloading does NOT count as activity, so a reload can never
 *    revive an expired session;
 *  - if storage is unavailable, an in-memory clock is used (never "now");
 *  - a stored timestamp in the future (tampering / clock skew) is ignored.
 */

export const ACTIVITY_KEY = "icu:last-activity";

const WRITE_THROTTLE_MS = 1000;
const FUTURE_TOLERANCE_MS = 5000;

const ACTIVITY_EVENTS = [
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
  "click",
  "wheel",
  "mousemove",
] as const;

type Options = {
  timeoutMs: number;
  warnMs?: number;
  onTimeout: () => void;
  onWarn?: () => void;
  /** Called (throttled by `activityPingMs`) on genuine user activity. */
  onActivity?: () => void;
  activityPingMs?: number;
  /** Per-session scope (the auth session id) so a new sign-in starts fresh. */
  scope?: string | null;
  enabled?: boolean;
};

function parseStored(raw: string | null, now: number): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > now + FUTURE_TOLERANCE_MS) return null;
  return n;
}

/**
 * Most recent trustworthy activity time. Prefers the shared stored value but
 * never lets it move later than real activity seen in this tab could justify
 * when storage is unreadable.
 */
export function resolveLastActivity(
  storedRaw: string | null | undefined,
  memoryLast: number,
  now: number,
): number {
  const stored = storedRaw === undefined ? null : parseStored(storedRaw, now);
  return stored == null ? memoryLast : Math.max(stored, memoryLast);
}

function readStorage(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined; // unavailable
  }
}

export function useInactivityTimeout({
  timeoutMs,
  warnMs = 60_000,
  onTimeout,
  onWarn,
  onActivity,
  activityPingMs = 60_000,
  scope,
  enabled = true,
}: Options) {
  const onTimeoutRef = useRef(onTimeout);
  const onWarnRef = useRef(onWarn);
  const onActivityRef = useRef(onActivity);
  onTimeoutRef.current = onTimeout;
  onWarnRef.current = onWarn;
  onActivityRef.current = onActivity;

  useEffect(() => {
    if (!enabled || !scope || typeof window === "undefined") return;
    const key = `${ACTIVITY_KEY}:${scope}`;

    let warned = false;
    let fired = false;
    let lastWrite = 0;
    let lastPing = 0;
    const now0 = Date.now();
    // Seed from the stored value if valid; only a missing value (first load of
    // a brand-new session) starts the clock at now. A reload keeps the old
    // clock, so an expired session times out immediately.
    const storedAtMount = readStorage(key);
    const parsedAtMount = storedAtMount === undefined ? null : parseStored(storedAtMount, now0);
    let memoryLast = parsedAtMount ?? now0;
    if (parsedAtMount == null && storedAtMount !== undefined) {
      try {
        localStorage.setItem(key, String(memoryLast));
      } catch {
        /* ignore */
      }
    }

    const check = () => {
      if (fired) return;
      const now = Date.now();
      const idle = now - resolveLastActivity(readStorage(key), memoryLast, now);
      if (idle >= timeoutMs) {
        fired = true;
        onTimeoutRef.current();
      } else if (warnMs > 0 && idle >= timeoutMs - warnMs && !warned) {
        warned = true;
        onWarnRef.current?.();
      }
    };

    const handleActivity = () => {
      if (fired || document.visibilityState === "hidden") return;
      const now = Date.now();
      // Never resurrect: activity after the deadline does not extend it.
      if (now - resolveLastActivity(readStorage(key), memoryLast, now) >= timeoutMs) {
        check();
        return;
      }
      memoryLast = now;
      warned = false;
      if (now - lastWrite >= WRITE_THROTTLE_MS) {
        lastWrite = now;
        try {
          localStorage.setItem(key, String(now));
        } catch {
          /* in-memory clock already updated */
        }
      }
      if (onActivityRef.current && now - lastPing >= activityPingMs) {
        lastPing = now;
        onActivityRef.current();
      }
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) warned = false;
    };

    ACTIVITY_EVENTS.forEach((evt) =>
      window.addEventListener(evt, handleActivity, { passive: true }),
    );
    window.addEventListener("storage", handleStorage);
    check();
    const interval = window.setInterval(check, 1000);

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, handleActivity));
      window.removeEventListener("storage", handleStorage);
      window.clearInterval(interval);
    };
  }, [enabled, scope, timeoutMs, warnMs, activityPingMs]);
}
