// Server-only core of "Confirm prefill" (fill blanks only, compare-and-set).
// Reads go through the caller's own client (RLS unit scoping applies); the
// write goes through one audited database transaction that repeats every
// check under locks (apply_referral_prefill).
import { encryptField } from "@/lib/crypto.server";
import { decryptPatientRow } from "@/lib/patient-crypto.server";
import { safeDbError } from "@/lib/db-error";
import { getAdmin } from "@/lib/admin-db.server";
import {
  computeReferralPrefill,
  prefillLinkState,
  REFERRAL_LINK_REQUIRED_MESSAGE,
  PREFILL_STALE_MESSAGE,
  REFERRAL_PREFILL_COLUMNS,
  type ReferralPrefillSource,
} from "@/lib/referral-prefill";

export type ApplyPrefillInput = {
  patient_id: string;
  referral_id: string;
  expected_patient_updated_at: string;
  expected_referral_updated_at: string | null;
  /** Decisions the user ticked in the preview (default: none). */
  accept_decisions?: readonly "dnacpr_decision"[];
};

type Ctx = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  userId: string;
  claims: Record<string, unknown>;
};

export async function applyReferralPrefill(context: Ctx, data: ApplyPrefillInput) {
  const { data: patient, error: pErr } = await context.supabase
    .from("patients")
    .select("*")
    .eq("id", data.patient_id)
    .maybeSingle();
  if (pErr) throw safeDbError(pErr);
  if (!patient) throw new Error("Patient not found");
  if (patient.updated_at !== data.expected_patient_updated_at) {
    throw new Error(PREFILL_STALE_MESSAGE);
  }
  // Only a patient ALREADY linked to exactly this referral can be filled from
  // it. Never inferred here; never established by this action.
  if (prefillLinkState(patient.source_referral_id, data.referral_id) !== "linked") {
    throw new Error(REFERRAL_LINK_REQUIRED_MESSAGE);
  }
  const patientPlain = decryptPatientRow(patient);

  const { data: ref, error: rErr } = await context.supabase
    .from("referrals")
    .select(REFERRAL_PREFILL_COLUMNS)
    .eq("id", data.referral_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (rErr) throw safeDbError(rErr);
  if (!ref) throw new Error("Referral not found");
  if (((ref.updated_at as string | null) ?? null) !== data.expected_referral_updated_at) {
    throw new Error(PREFILL_STALE_MESSAGE);
  }

  const source: ReferralPrefillSource = {
    reason_category: ref.reason_category ?? null,
    ceiling_of_care: ref.ceiling_of_care ?? null,
    resus_status: ref.resus_status ?? null,
    dnacpr_respect: ref.dnacpr_respect ?? null,
    anticipated_interventions: (ref.anticipated_interventions as string[] | null) ?? null,
    allergies: ref.allergies ?? null,
    weight_kg: ref.weight_kg ?? null,
    admission_urgency: ref.admission_urgency ?? null,
  };

  const { patch, applied_fields, skipped_fields, decisions } = computeReferralPrefill(source, {
    current_admission: patientPlain.current_admission,
    current_management: patientPlain.current_management,
    tep_in_place: patientPlain.tep_in_place,
    tep_details: patientPlain.tep_details,
    dnacpr_decision: patientPlain.dnacpr_decision,
    dnacpr_details: patientPlain.dnacpr_details,
  });

  // A ticked decision must still be on offer (patient field still unset and
  // the referral unchanged); otherwise the preview is stale.
  const decisionPatch: Record<string, boolean> = {};
  for (const field of data.accept_decisions ?? []) {
    const offered = decisions.find((d) => d.field === field);
    if (!offered) throw new Error(PREFILL_STALE_MESSAGE);
    decisionPatch[field] = offered.value;
    applied_fields.push(field);
  }

  if (Object.keys(patch).length === 0 && Object.keys(decisionPatch).length === 0) {
    // Nothing blank to fill: no write, nothing to audit.
    return { applied_fields, skipped_fields, patient: patientPlain };
  }

  // The write itself happens in ONE database transaction
  // (public.apply_referral_prefill, staged 0009): it re-checks the caller's
  // session, role and unit, locks the referral then the patient, requires the
  // previewed revisions, the exact existing link and still-blank targets, and
  // writes the audit and field history alongside. Service role only, so a
  // browser can't call it with its own values; the actor and session come
  // from the caller's verified token.
  const sessionId = context.claims.session_id;
  if (typeof sessionId !== "string" || !sessionId) throw new Error(PREFILL_NOT_AUTHORISED_MESSAGE);
  const set: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    const sealed = encryptField(value as string);
    if (sealed) set[field] = sealed;
  }
  const supabaseAdmin = await getAdmin();
  const { data: out, error } = await supabaseAdmin.rpc("apply_referral_prefill", {
    _actor: context.userId,
    _session_id: sessionId,
    _req: {
      patient_id: data.patient_id,
      referral_id: data.referral_id,
      expected_patient_updated_at: data.expected_patient_updated_at,
      expected_referral_updated_at: data.expected_referral_updated_at,
      set,
      ...("dnacpr_decision" in decisionPatch
        ? { dnacpr_decision: decisionPatch.dnacpr_decision }
        : {}),
    },
  });
  if (error) throw safeDbError(error);
  const result = out as { ok: boolean; code?: string; patient?: Record<string, unknown> } | null;
  if (!result?.ok || !result.patient) throw new Error(prefillRefusalMessage(result?.code));
  return { applied_fields, skipped_fields, patient: decryptPatientRow(result.patient) };
}

export const PREFILL_NOT_AUTHORISED_MESSAGE =
  "Your session is locked or has ended. Nothing was changed — sign in again and retry.";

/** Typed refusals from apply_referral_prefill; nothing was written for any of them. */
export function prefillRefusalMessage(code: string | undefined): string {
  switch (code) {
    case "link_required":
      return REFERRAL_LINK_REQUIRED_MESSAGE;
    case "not_found":
      return "Patient not found";
    case "referral_unavailable":
      return "Referral not found";
    case "not_authorised":
      return PREFILL_NOT_AUTHORISED_MESSAGE;
    default:
      return PREFILL_STALE_MESSAGE;
  }
}
