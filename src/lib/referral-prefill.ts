// Pure, client-safe mapping from a synced partner referral to this app's
// patient handover fields. No I/O — importable in server fns, UI, and tests.
//
// IMPORTANT: the free-text clinical narrative on a referral (past medical
// history, presenting complaint, baseline/functional history) is stored
// *encrypted* in the partner app and is intentionally NOT exposed over the
// bridge, so it is never present on the rows we sync. Those fields are filled
// separately by the partner's own "Prefill handover" push. Here we only map
// the structured, non-encrypted referral fields we actually receive.

export const CEILING_OF_CARE_LABEL: Record<string, string> = {
  full_escalation: "Full escalation",
  no_cpr: "Full escalation, not for CPR",
  ward_based: "Ward-based care only",
  symptom_control: "Symptom control / palliative",
  not_documented: "Not documented",
};

export const RESUS_STATUS_LABEL: Record<string, string> = {
  for_cpr: "For CPR",
  dnacpr: "DNACPR in place",
  not_documented: "Not documented",
};

export const REASON_CATEGORY_LABEL: Record<string, string> = {
  respiratory_failure: "Respiratory failure",
  sepsis: "Sepsis",
  shock: "Shock / haemodynamic",
  post_op: "Post-operative",
  neurology: "Neurological",
  trauma: "Trauma",
  gi_bleed: "GI bleed",
  metabolic: "Metabolic / endocrine",
  overdose: "Overdose / poisoning",
  other: "Other",
};

export const ANTICIPATED_INTERVENTION_LABEL: Record<string, string> = {
  invasive_ventilation: "Invasive ventilation",
  niv_cpap: "NIV / CPAP",
  hfno: "HFNO",
  vasopressors: "Vasopressors",
  rrt: "Renal replacement",
  neuro_obs: "Neuro observations",
  arterial_line: "Arterial line",
  central_line: "Central line",
  other: "Other",
};

export const ADMISSION_URGENCY_LABEL: Record<string, string> = {
  immediate: "Immediate",
  urgent: "Urgent",
  routine: "Routine",
};

const label = (map: Record<string, string>, v: string | null | undefined): string | null =>
  v ? (map[v] ?? v) : null;

// The referral fields we can read from a synced partner referral row.
export interface ReferralPrefillSource {
  reason_category: string | null;
  ceiling_of_care: string | null;
  resus_status: string | null;
  dnacpr_respect: boolean | null;
  anticipated_interventions: string[] | null;
  allergies: string | null;
  weight_kg: number | null;
  admission_urgency: string | null;
}

// The patient fields we may fill (fill-blanks only).
export interface PatientPrefillTarget {
  current_admission: string | null;
  current_management: string | null;
  tep_in_place: boolean | null;
  tep_details: string | null;
  dnacpr_decision: boolean | null;
  dnacpr_details: string | null;
}

export interface ReferralPrefillPlan {
  patch: Record<string, string | boolean>;
  applied_fields: string[];
  skipped_fields: string[];
}

function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function composeCurrentManagement(ref: ReferralPrefillSource): string | null {
  const parts: string[] = [];
  if (ref.anticipated_interventions && ref.anticipated_interventions.length) {
    parts.push(
      `Anticipated interventions: ${ref.anticipated_interventions
        .map((v) => label(ANTICIPATED_INTERVENTION_LABEL, v))
        .join(", ")}.`,
    );
  }
  if (ref.allergies && ref.allergies.trim()) parts.push(`Allergies: ${ref.allergies.trim()}.`);
  if (ref.weight_kg != null) parts.push(`Weight: ${ref.weight_kg} kg.`);
  const urg = label(ADMISSION_URGENCY_LABEL, ref.admission_urgency);
  if (urg) parts.push(`Admission urgency: ${urg}.`);
  return parts.length ? parts.join("\n") : null;
}

function composeTepDetails(ref: ReferralPrefillSource): string | null {
  const bits: string[] = [];
  const c = label(CEILING_OF_CARE_LABEL, ref.ceiling_of_care);
  const r = label(RESUS_STATUS_LABEL, ref.resus_status);
  if (c) bits.push(`Ceiling of care: ${c}`);
  if (r) bits.push(`Resus status: ${r}`);
  if (!bits.length) return null;
  return `${bits.join(". ")}. (Auto-populated from critical care referral.)`;
}

function composeDnacprDetails(ref: ReferralPrefillSource): string | null {
  if (ref.resus_status === "dnacpr") return "DNACPR documented on critical care referral.";
  if (ref.dnacpr_respect === true) return "ReSPECT / DNACPR form recorded on critical care referral.";
  return null;
}

/**
 * Decide, fill-blanks-only, which patient fields the referral would populate.
 * Mirrors the partner's prefill contract so behaviour is consistent whichever
 * app initiates it.
 */
export function computeReferralPrefill(
  ref: ReferralPrefillSource,
  patient: PatientPrefillTarget,
): ReferralPrefillPlan {
  const wantsDnacpr = ref.resus_status === "dnacpr" || ref.dnacpr_respect === true;
  const wantsTep =
    !!ref.ceiling_of_care ||
    !!ref.resus_status ||
    wantsDnacpr ||
    (ref.anticipated_interventions?.length ?? 0) > 0;

  const proposed: Record<string, string | boolean | null | undefined> = {
    current_admission: label(REASON_CATEGORY_LABEL, ref.reason_category),
    current_management: composeCurrentManagement(ref),
    tep_in_place: wantsTep ? true : undefined,
    tep_details: composeTepDetails(ref),
    dnacpr_decision: wantsDnacpr ? true : undefined,
    dnacpr_details: composeDnacprDetails(ref),
  };

  const applied: string[] = [];
  const skipped: string[] = [];
  const patch: Record<string, string | boolean> = {};

  const textFields = [
    "current_admission",
    "current_management",
    "tep_details",
    "dnacpr_details",
  ] as const;
  for (const k of textFields) {
    const val = proposed[k];
    if (val == null || val === "") continue;
    if (isBlank((patient as unknown as Record<string, unknown>)[k])) {
      patch[k] = val as string;
      applied.push(k);
    } else {
      skipped.push(k);
    }
  }

  if (proposed.tep_in_place === true) {
    if (!patient.tep_in_place) {
      patch.tep_in_place = true;
      applied.push("tep_in_place");
    } else {
      skipped.push("tep_in_place");
    }
  }
  if (proposed.dnacpr_decision === true) {
    if (!patient.dnacpr_decision) {
      patch.dnacpr_decision = true;
      applied.push("dnacpr_decision");
    } else {
      skipped.push("dnacpr_decision");
    }
  }

  return { patch, applied_fields: applied, skipped_fields: skipped };
}

export const PREFILL_FIELD_LABEL: Record<string, string> = {
  current_admission: "Current admission",
  current_management: "Current management",
  tep_in_place: "TEP in place",
  tep_details: "TEP details",
  dnacpr_decision: "DNACPR decision",
  dnacpr_details: "DNACPR details",
};

// A concise, PHI-light one-line summary of a referral for the picker.
export function referralCandidateSummary(r: {
  age: number | null;
  sex: string | null;
  current_ward: string | null;
  referring_specialty: string | null;
  reason_category: string | null;
}): string {
  const bits: string[] = [];
  if (r.age != null) bits.push(`${r.age}y`);
  if (r.sex) bits.push(r.sex);
  const reason = label(REASON_CATEGORY_LABEL, r.reason_category);
  if (reason) bits.push(reason);
  if (r.referring_specialty) bits.push(r.referring_specialty);
  if (r.current_ward) bits.push(r.current_ward);
  return bits.join(" · ") || "Referral";
}
