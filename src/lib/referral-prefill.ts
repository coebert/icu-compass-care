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

/** A decision explicitly documented on the referral, offered for confirmation. */
export interface PrefillDecision {
  field: "dnacpr_decision";
  value: boolean;
  /** Plain-language description of what the referral records. */
  label: string;
}
export const PREFILL_DECISION_FIELDS = ["dnacpr_decision"] as const;

export interface ReferralPrefillPlan {
  /** Fill-blank TEXT only: referral information labelled as needing review. */
  patch: Record<string, string | boolean>;
  applied_fields: string[];
  skipped_fields: string[];
  /**
   * Decisions explicitly documented on the referral, offered ONLY when the
   * patient's field is genuinely unset (null). Never applied unless the user
   * ticks them in the preview and confirms.
   */
  decisions: PrefillDecision[];
}

/** Prefix on every prefilled text: it is referral information, not a local decision. */
export const REFERRAL_INFO_PREFIX = "From critical care referral — needs review:";

function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function composeCurrentManagement(ref: ReferralPrefillSource): string | null {
  const parts: string[] = [];
  if (ref.anticipated_interventions && ref.anticipated_interventions.length) {
    parts.push(
      `Anticipated interventions (referrer's expectation, not a plan): ${ref.anticipated_interventions
        .map((v) => label(ANTICIPATED_INTERVENTION_LABEL, v))
        .join(", ")}.`,
    );
  }
  if (ref.allergies && ref.allergies.trim()) parts.push(`Allergies: ${ref.allergies.trim()}.`);
  if (ref.weight_kg != null) parts.push(`Weight: ${ref.weight_kg} kg.`);
  const urg = label(ADMISSION_URGENCY_LABEL, ref.admission_urgency);
  if (urg) parts.push(`Admission urgency: ${urg}.`);
  return parts.length ? `${REFERRAL_INFO_PREFIX}\n${parts.join("\n")}` : null;
}

// Escalation information as recorded on the referral. Explicitly NOT a
// completed treatment escalation plan for this admission.
function composeTepDetails(ref: ReferralPrefillSource): string | null {
  const bits: string[] = [];
  const c = label(CEILING_OF_CARE_LABEL, ref.ceiling_of_care);
  const r = label(RESUS_STATUS_LABEL, ref.resus_status);
  if (c) bits.push(`Ceiling of care: ${c}.`);
  if (r) bits.push(`Resus status: ${r}.`);
  if (ref.dnacpr_respect === true) bits.push("A ReSPECT form is recorded on the referral.");
  if (!bits.length) return null;
  return `${REFERRAL_INFO_PREFIX} ${bits.join(" ")} Not a completed TEP for this admission.`;
}

function composeDnacprDetails(ref: ReferralPrefillSource): string | null {
  // Only an explicit DNACPR resus status. A ReSPECT form does NOT mean DNACPR.
  if (ref.resus_status === "dnacpr") {
    return `${REFERRAL_INFO_PREFIX} the referral records a DNACPR decision. Confirm and document it locally.`;
  }
  return null;
}

/**
 * Decide, fill-blanks-only, what a referral would add to a patient.
 *
 * - Text fields are filled only when blank, always labelled as referral
 *   information needing review.
 * - tep_in_place is never set: anticipated interventions, "not documented"
 *   or a generic resus status don't mean a TEP was completed.
 * - dnacpr_decision is never set automatically. An explicit referral resus
 *   status (DNACPR / for CPR) is OFFERED as a decision only when the
 *   patient's field is null; an explicit false (or true) is left alone. A
 *   ReSPECT form does not imply DNACPR.
 */
export function computeReferralPrefill(
  ref: ReferralPrefillSource,
  patient: PatientPrefillTarget,
): ReferralPrefillPlan {
  const reason = label(REASON_CATEGORY_LABEL, ref.reason_category);
  const proposed: Record<string, string | null> = {
    current_admission: reason ? `${REFERRAL_INFO_PREFIX} referral reason: ${reason}.` : null,
    current_management: composeCurrentManagement(ref),
    tep_details: composeTepDetails(ref),
    dnacpr_details: composeDnacprDetails(ref),
  };

  const applied: string[] = [];
  const skipped: string[] = [];
  const patch: Record<string, string | boolean> = {};
  for (const [k, val] of Object.entries(proposed)) {
    if (val == null || val === "") continue;
    if (isBlank((patient as unknown as Record<string, unknown>)[k])) {
      patch[k] = val;
      applied.push(k);
    } else {
      skipped.push(k);
    }
  }

  const decisions: PrefillDecision[] = [];
  const explicit =
    ref.resus_status === "dnacpr" ? true : ref.resus_status === "for_cpr" ? false : null;
  if (explicit !== null) {
    if (patient.dnacpr_decision === null || patient.dnacpr_decision === undefined) {
      decisions.push({
        field: "dnacpr_decision",
        value: explicit,
        label: explicit
          ? "The referral records DNACPR in place."
          : "The referral records the patient as for CPR (no DNACPR).",
      });
    } else {
      skipped.push("dnacpr_decision");
    }
  }

  return { patch, applied_fields: applied, skipped_fields: skipped, decisions };
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
  if (r.sex) {
    const sym = r.sex === "male" ? "♂" : r.sex === "female" ? "♀" : r.sex === "other" ? "⚧" : "?";
    bits.push(sym);
  }
  const reason = label(REASON_CATEGORY_LABEL, r.reason_category);
  if (reason) bits.push(reason);
  if (r.referring_specialty) bits.push(r.referring_specialty);
  if (r.current_ward) bits.push(r.current_ward);
  return bits.join(" · ") || "Referral";
}

/**
 * Shown when "Confirm prefill" is pressed on a preview that no longer matches
 * the record (someone edited the patient, or the referral re-synced, after the
 * preview was loaded). Nothing is written; the user must reload and reconfirm.
 */
export const PREFILL_STALE_MESSAGE =
  "This record changed after the preview was shown. Nothing was changed — reload the preview and confirm again.";

/** Referral columns read for preview and apply (structured fields only). */
export const REFERRAL_PREFILL_COLUMNS =
  "id, updated_at, reason_category, ceiling_of_care, resus_status, dnacpr_respect, anticipated_interventions, allergies, weight_kg, admission_urgency";

/**
 * Shown when the patient isn't already linked to the chosen referral. This
 * app never infers who a referral is about from age, ward or initials; the
 * match is confirmed in Critical Care Connect (exact hospital number against
 * the fresh Hub record), which then records the link.
 */
export const REFERRAL_LINK_REQUIRED_MESSAGE =
  "This patient isn't linked to that referral, so nothing can be copied here. Open the referral in Critical Care Connect to confirm the match.";

export type PrefillLinkState = "linked" | "unlinked" | "mismatch";

/** linked only when the patient already points at exactly this referral. */
export function prefillLinkState(sourceReferralId: unknown, referralId: string): PrefillLinkState {
  if (typeof sourceReferralId !== "string" || sourceReferralId === "") return "unlinked";
  return sourceReferralId.toLowerCase() === referralId.toLowerCase() ? "linked" : "mismatch";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Link to a referral in Critical Care Connect: the partner origin plus the
 * opaque referral id only. No patient identifier is ever put in the URL.
 * null when the partner address isn't a valid https origin.
 */
export function partnerReferralUrl(
  partnerBase: string | null | undefined,
  referralId: string,
): string | null {
  if (!partnerBase || !UUID_RE.test(referralId)) return null;
  let origin: string;
  try {
    const u = new URL(partnerBase);
    if (u.protocol !== "https:") return null;
    origin = u.origin;
  } catch {
    return null;
  }
  return `${origin}/referrals/${referralId.toLowerCase()}`;
}
