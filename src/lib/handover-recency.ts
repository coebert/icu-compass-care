import type { HandoverInvestigation, HandoverMicrobiology } from "@/lib/handover-types";

/**
 * The investigation categories the handover sheet surfaces as dedicated
 * "most recent" lines, in display order. Their labels drive the text rendered
 * for each patient's investigations column.
 */
export const RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] as const;

function parseTime(value?: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Stable string for a deterministic final tie-break (never throws). */
function tieBreakKey(rec: Record<string, any>): string {
  const id = rec?.id;
  if (id != null) return String(id);
  const created = rec?.created_at;
  if (created != null) return String(created);
  return String(rec?.findings ?? "");
}

/**
 * Deterministic "is `a` at least as recent as `b`?" for picking the newest
 * record. Ordering is total and independent of input array order:
 *   1. Newer `result_at` wins. Missing/invalid dates sort oldest.
 *   2. Ties on `result_at` (including two missing dates) break on the newer
 *      `created_at` (missing/invalid sorts oldest).
 *   3. Remaining ties break on a stable key (id, else created_at, else
 *      findings) using string comparison, so the result never depends on the
 *      order the records happened to arrive in.
 */
function isAtLeastAsRecent(a: Record<string, any>, b: Record<string, any>): boolean {
  const ta = parseTime(a?.result_at);
  const tb = parseTime(b?.result_at);
  if (ta !== tb) return ta > tb;
  const ca = parseTime(a?.created_at);
  const cb = parseTime(b?.created_at);
  if (ca !== cb) return ca > cb;
  return tieBreakKey(a) >= tieBreakKey(b);
}

/** Shared time parser for consumers that only need chronological ordering. */
export { parseTime };

/**
 * Pick the newest investigation for `category` from a patient's investigation
 * list. Selection is deterministic even when several results share the same
 * `result_at` (or all have missing dates) — see `isAtLeastAsRecent`. Returns
 * undefined when none exist.
 */
export function mostRecentInvestigation(
  investigations: HandoverInvestigation[] | null | undefined,
  category: string,
): HandoverInvestigation | undefined {
  if (!investigations?.length) return undefined;
  return investigations
    .filter((i) => (i.category ?? "").toLowerCase() === category.toLowerCase())
    .reduce<HandoverInvestigation | undefined>((best, cur) => {
      if (!best) return cur;
      return isAtLeastAsRecent(cur, best) ? cur : best;
    }, undefined);
}

/**
 * Pick the newest microbiology result per specimen type from a patient's
 * microbiology list, comparing by `result_at`. Returns one entry per specimen
 * type that has any result, ordered by most recent result first.
 */
export function latestMicrobiologyPerSpecimen(
  results: HandoverMicrobiology[] | null | undefined,
): HandoverMicrobiology[] {
  if (!results?.length) return [];
  const bySpecimen = new Map<string, HandoverMicrobiology>();
  for (const r of results) {
    const specimen = (r.specimen_type ?? "").trim() || "Other";
    const existing = bySpecimen.get(specimen);
    if (!existing || parseTime(r.result_at) >= parseTime(existing.result_at)) {
      bySpecimen.set(specimen, r);
    }
  }
  return [...bySpecimen.values()].sort(
    (a, b) => parseTime(b.result_at) - parseTime(a.result_at),
  );
}
