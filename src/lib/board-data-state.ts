// Pure, client-safe rules for what the patient board may claim from the data
// it has. The board must never present a bed as free when the data behind it
// failed to load, is out of date, or is hidden by a filter.
import { normalizeBed } from "@/lib/icu-beds";

export type QueryDataState =
  | { kind: "loading" }
  /** Never loaded in this session: nothing trustworthy to show. */
  | { kind: "failed" }
  /** Last good data from this session is shown, but the latest refresh failed. */
  | { kind: "stale"; lastGoodAt: number }
  | { kind: "ready"; lastGoodAt: number };

export function queryDataState(q: {
  data: unknown;
  isPending: boolean;
  isError: boolean;
  dataUpdatedAt: number;
}): QueryDataState {
  if (q.data === undefined) return q.isError ? { kind: "failed" } : { kind: "loading" };
  return q.isError
    ? { kind: "stale", lastGoodAt: q.dataUpdatedAt }
    : { kind: "ready", lastGoodAt: q.dataUpdatedAt };
}

/** Bed availability can only be acted on when every input is fresh. */
export function availabilityConfirmed(...states: QueryDataState[]): boolean {
  return states.every((s) => s.kind === "ready");
}

export type EmptyKind = "has_results" | "confirmed_empty" | "filtered_empty";

/**
 * Distinguish "nobody here" from "nobody matches the filters".
 * `inView` counts records in the current view before sex/preset filters.
 */
export function emptyKind(opts: { inView: number; visible: number }): EmptyKind {
  if (opts.visible > 0) return "has_results";
  return opts.inView > 0 ? "filtered_empty" : "confirmed_empty";
}

type BedPatient = { id: string; bed?: string | null };

/**
 * Occupancy is computed from EVERY active ICU patient; filters only decide
 * which cards are drawn. A bed whose occupants are all filtered out is
 * reported in `hiddenBeds` so it renders as occupied, never as empty.
 */
export function splitOccupancy<P extends BedPatient>(
  activeIcu: P[],
  visibleIds: Set<string>,
  rosterLabels: string[],
) {
  const rosterKeys = new Set(rosterLabels.map((l) => normalizeBed(l)));
  const allByBed = new Map<string, P[]>();
  const visibleByBed = new Map<string, P[]>();
  const unassignedVisible: P[] = [];
  for (const p of activeIcu) {
    const key = normalizeBed(p.bed);
    if (!key || !rosterKeys.has(key)) {
      if (visibleIds.has(p.id)) unassignedVisible.push(p);
      continue;
    }
    (allByBed.get(key) ?? allByBed.set(key, []).get(key)!).push(p);
    if (visibleIds.has(p.id))
      (visibleByBed.get(key) ?? visibleByBed.set(key, []).get(key)!).push(p);
  }
  const hiddenBeds = new Set<string>();
  for (const [key, list] of allByBed) {
    const shown = visibleByBed.get(key)?.length ?? 0;
    if (shown < list.length) hiddenBeds.add(key);
  }
  return { allByBed, visibleByBed, hiddenBeds, unassignedVisible };
}

export function ageText(sinceMs: number, now: number): string {
  const mins = Math.max(0, Math.round((now - sinceMs) / 60000));
  if (mins < 1) return "less than a minute ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} h ago`;
}
