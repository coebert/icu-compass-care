/**
 * Radnor Critical Care Unit bed roster helpers.
 *
 * The roster is now editable by admins and stored in the `icu_beds` table
 * (see src/lib/beds.functions.ts). This module keeps the shared, pure helpers
 * plus a DEFAULT roster used as a fallback when the database is empty or
 * unreachable so the bed board never renders blank.
 */

export type BedSlot = { label: string; is_side_room: boolean };

/** Fallback roster: two side rooms then open-bay beds 3–10. */
export const DEFAULT_BEDS: BedSlot[] = [
  { label: "SR1", is_side_room: true },
  { label: "SR2", is_side_room: true },
  { label: "3", is_side_room: false },
  { label: "4", is_side_room: false },
  { label: "5", is_side_room: false },
  { label: "6", is_side_room: false },
  { label: "7", is_side_room: false },
  { label: "8", is_side_room: false },
  { label: "9", is_side_room: false },
  { label: "10", is_side_room: false },
];

/** Case-insensitive, whitespace-tolerant bed key for comparisons. */
export const normalizeBed = (b: unknown) => String(b ?? "").trim().toUpperCase();

/** True when the given bed label is a side room within the supplied roster. */
export function isSideRoom(bed: unknown, roster: BedSlot[] = DEFAULT_BEDS): boolean {
  const key = normalizeBed(bed);
  return roster.some((b) => b.is_side_room && normalizeBed(b.label) === key);
}

/** True when the given bed label matches a known slot within the roster. */
export function isKnownBed(bed: unknown, roster: BedSlot[] = DEFAULT_BEDS): boolean {
  const key = normalizeBed(bed);
  return roster.some((b) => normalizeBed(b.label) === key);
}

/** A patient shape with the fields relevant to bed eligibility. */
export type BedCandidate = {
  status?: string | null;
  isolation_required?: boolean | null;
};

/** Result of an eligibility check: ok, plus a human reason when not ok. */
export type BedEligibility = { ok: boolean; reason?: string };

/**
 * Decide whether `patient` may occupy the bed labelled `bedLabel`.
 *
 * Constraints (see the bed board drag-and-drop):
 *  - Only active patients (admitted / referred) can occupy a bed.
 *  - Patients flagged as requiring isolation may only go into a side room.
 */
export function checkBedEligibility(
  patient: BedCandidate,
  bedLabel: string,
  roster: BedSlot[] = DEFAULT_BEDS,
): BedEligibility {
  const active = patient.status === "admitted" || patient.status === "referred";
  if (!active) {
    return { ok: false, reason: "Only active (admitted or referred) patients can occupy a bed." };
  }
  if (patient.isolation_required && !isSideRoom(bedLabel, roster)) {
    return { ok: false, reason: "This patient requires isolation and can only be placed in a side room." };
  }
  return { ok: true };
}
