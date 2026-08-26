// Pure, testable validation for handover PDF generation. A handover sheet must
// never be produced for a patient missing the fields that make the row safe and
// unambiguous, so this is the single source of truth for both the export guard
// and the amber "Missing" warning in the UI.

/** Minimal shape needed to validate a patient for handover export. */
export interface HandoverCriticalPatient {
  full_name?: string | null;
  hospital_number?: string | null;
  ward?: string | null;
  bed?: string | null;
  current_admission?: string | null;
}

/**
 * Returns the human-readable labels of critical fields that are missing. An
 * empty array means the patient is safe to export. Location (ward/bed) counts
 * as one requirement since either identifies where the patient is.
 */
export function missingCriticalFields(
  p: HandoverCriticalPatient | null | undefined,
): string[] {
  if (!p) return ["Patient record"];
  const missing: string[] = [];
  if (!p.full_name?.trim()) missing.push("Patient initials");
  if (!p.hospital_number?.trim()) missing.push("Hospital number");
  if (!p.ward?.trim() && !p.bed?.trim()) missing.push("Location (ward/bed)");
  if (!p.current_admission?.trim()) missing.push("Current admission");
  return missing;
}

/** True when the patient has everything required to generate a handover PDF. */
export function canGenerateHandover(
  p: HandoverCriticalPatient | null | undefined,
): boolean {
  return missingCriticalFields(p).length === 0;
}
