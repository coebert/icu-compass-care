// Pure, DST-aware shift-gating logic for the twice-daily handover snapshot.
//
// This module has NO server-only imports (no admin DB client), so it is safe to
// import from tests and anywhere else. `captureHandoverSnapshot`
// (handover-snapshot.server.ts) delegates all of its "which shift / should we
// capture at all" decisions here.
//
// The 08:00 / 20:00 handover boundaries are defined in Europe/London wall-clock
// time. Because the UK observes daylight saving (GMT in winter, BST in summer),
// the corresponding UTC instant shifts by an hour across the year — 08:00 London
// is 08:00 UTC in winter but 07:00 UTC in summer. All reasoning goes through
// `londonParts`, which resolves the true local wall-clock time via Intl, so the
// gating stays correct across DST changes without any manual offset maths.

export type ShiftKey = "am" | "pm";

export type LondonParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  isoDate: string; // YYYY-MM-DD
};

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Break a moment down into Europe/London wall-clock parts so the 8am / 8pm
// shift boundaries follow British local time across BST/GMT changes.
export function londonParts(d: Date): LondonParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // Intl can emit "24" for midnight in some engines; normalise to 0.
  const hour = Number(parts.hour) % 24;
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
  return { year, month, day, hour, isoDate };
}

// Decide which shift a moment belongs to. Mornings (00:00–13:59) map to the
// 8am handover, afternoons/evenings to the 8pm handover.
export function shiftForHour(hour: number): ShiftKey {
  return hour < 14 ? "am" : "pm";
}

export function labelFor(parts: LondonParts, shift: ShiftKey): string {
  const time = shift === "am" ? "08:00" : "20:00";
  return `${time} · ${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`;
}

export type ShiftGateDecision =
  | { capture: true; shift: ShiftKey; parts: LondonParts }
  | { capture: false; reason: string; parts: LondonParts };

// The single source of truth for whether a snapshot should be captured at a
// given instant and, if so, for which shift.
//
// - `force: true` (admin "Capture now"): always capture, mapping to whichever
//   shift the current London time is nearest.
// - `force: false` (scheduled cron): only capture during the 08:00 or 20:00
//   London handover hour, so an hourly cron produces exactly two versions/day
//   regardless of DST.
export function decideShiftGate(now: Date, force = false): ShiftGateDecision {
  const parts = londonParts(now);

  if (force) {
    return { capture: true, shift: shiftForHour(parts.hour), parts };
  }

  if (parts.hour === 8) return { capture: true, shift: "am", parts };
  if (parts.hour === 20) return { capture: true, shift: "pm", parts };

  return {
    capture: false,
    reason: `Not a handover hour (London ${String(parts.hour).padStart(2, "0")}:00)`,
    parts,
  };
}
