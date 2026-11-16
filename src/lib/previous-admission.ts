// Previous critical care admissions shown while a new patient is being added.
//
// Identity rule: a previous record is the same person ONLY when its hospital
// number matches the one being entered exactly after normalisation (the same
// normalisation as the keyed lookup hash). Initials + age never establish
// identity. Copy rule: only past medical history (non-decision text) may be
// copied, only into a blank field, labelled with its source and date for
// review. Historical TEP / DNACPR decisions, dates and exclusions are shown
// for review only — a current decision is always a fresh clinician entry.
import { fmtDate } from "@/lib/icu";

export type PreviousAdmission = {
  id: string;
  full_name: string | null;
  hospital_number: string | null;
  age: number | null;
  status: string | null;
  admission_date: string | null;
  discharge_date: string | null;
  date_of_death: string | null;
  past_medical_history: string | null;
  tep_in_place: boolean | null;
  tep_details: string | null;
  dnacpr_decision: boolean | null;
  dnacpr_details: string | null;
  dnacpr_date: string | null;
};

/** Same canonical form as the server's lookup hash (trim, upper case, A-Z0-9 only). */
export function normaliseHospitalNumber(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Records whose own hospital number exactly matches the entered one. */
export function verifiedPreviousAdmissions<T extends { hospital_number: string | null }>(
  enteredHospitalNumber: string | null | undefined,
  rows: readonly T[],
): T[] {
  const want = normaliseHospitalNumber(enteredHospitalNumber);
  if (!want) return [];
  return rows.filter((r) => normaliseHospitalNumber(r.hospital_number) === want);
}

/** "01/02/2026 – 05/02/2026" style label for where historical text came from. */
export function admissionPeriodLabel(p: PreviousAdmission): string {
  const start = p.admission_date ? fmtDate(p.admission_date) : "date unknown";
  const endRaw = p.discharge_date ?? p.date_of_death ?? null;
  const end = endRaw ? fmtDate(endRaw) : "date unknown";
  return `${start} – ${end}`;
}

export const HISTORICAL_PMH_PREFIX = "From previous critical care admission";

/**
 * The only patch ever offered: past medical history into a blank field,
 * labelled with its source and dates for review. Null when nothing may be copied.
 */
export function historicalPmhPatch(
  current: { past_medical_history: string },
  source: PreviousAdmission,
): { past_medical_history: string } | null {
  if (current.past_medical_history.trim() !== "") return null;
  const pmh = (source.past_medical_history ?? "").trim();
  if (!pmh) return null;
  return {
    past_medical_history: `${HISTORICAL_PMH_PREFIX} (${admissionPeriodLabel(source)}) — needs review:\n${pmh}`,
  };
}

/**
 * Applies a historical patch to the LATEST form state only if that form is
 * still for the same hospital number the patch was verified against and the
 * target field is still blank. A late result for an earlier number, or text
 * typed meanwhile, always wins over the patch.
 */
export function applyHistoricalPatch<
  F extends { hospital_number: string; past_medical_history: string },
>(form: F, patch: { past_medical_history: string }, verifiedFor: string): F {
  const target = normaliseHospitalNumber(form.hospital_number);
  if (!target || target !== verifiedFor) return form;
  if (form.past_medical_history.trim() !== "") return form;
  return { ...form, past_medical_history: patch.past_medical_history };
}
