/**
 * Radnor Critical Care Unit bed roster — the single source of truth shared by
 * the in-app bed board and the cross-project data bridge.
 *
 * The unit has 10 beds; the first two are side rooms (SR1, SR2).
 */
export const ICU_BEDS = ["SR1", "SR2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;

export type IcuBed = (typeof ICU_BEDS)[number];

/** Beds that are single side rooms rather than open-bay beds. */
export const SIDE_ROOMS = ["SR1", "SR2"] as const;

/** Case-insensitive, whitespace-tolerant bed key for comparisons. */
export const normalizeBed = (b: unknown) => String(b ?? "").trim().toUpperCase();

/** True when the given bed label is one of the unit's side rooms. */
export function isSideRoom(bed: unknown): boolean {
  const key = normalizeBed(bed);
  return SIDE_ROOMS.some((sr) => normalizeBed(sr) === key);
}

/** True when the given bed label matches a known unit bed slot. */
export function isKnownBed(bed: unknown): boolean {
  const key = normalizeBed(bed);
  return ICU_BEDS.some((b) => normalizeBed(b) === key);
}
