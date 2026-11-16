// Server-only core of "Confirm prefill" (fill blanks only, compare-and-set).
// Runs through the caller's own client, so RLS unit scoping and edit
// permissions apply exactly as for any other patient update.
import { encryptField } from "@/lib/crypto.server";
import {
  PATIENT_ENCRYPTED_FIELDS,
  decryptPatientRow,
  encryptPatientPayload,
} from "@/lib/patient-crypto.server";
import { safeDbError } from "@/lib/db-error";
import { diffFields, writeAudit, writePatientFieldChanges } from "@/lib/audit";
import { getAdmin } from "@/lib/admin-db.server";
import {
  computeReferralPrefill,
  PREFILL_STALE_MESSAGE,
  REFERRAL_PREFILL_COLUMNS,
  type ReferralPrefillSource,
} from "@/lib/referral-prefill";

export type ApplyPrefillInput = {
  patient_id: string;
  referral_id: string;
  expected_patient_updated_at: string;
  expected_referral_updated_at: string | null;
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

  const { patch, applied_fields, skipped_fields } = computeReferralPrefill(source, {
    current_admission: patientPlain.current_admission,
    current_management: patientPlain.current_management,
    tep_in_place: patientPlain.tep_in_place,
    tep_details: patientPlain.tep_details,
    dnacpr_decision: patientPlain.dnacpr_decision,
    dnacpr_details: patientPlain.dnacpr_details,
  });

  // Always record the link so the card can surface its referral origin, even
  // if every mapped field was already populated.
  const updatePayload = {
    ...patch,
    source_referral_id: data.referral_id,
    updated_by: context.userId,
  };

  // The updated_at predicate makes the write atomic against a concurrent
  // edit landing between our read and this update.
  const { data: row, error } = await context.supabase
    .from("patients")
    .update(encryptPatientPayload(updatePayload) as never)
    .eq("id", data.patient_id)
    .eq("updated_at", data.expected_patient_updated_at)
    .select()
    .maybeSingle();
  if (error) throw safeDbError(error);
  if (!row) {
    const { data: still, error: sErr } = await context.supabase
      .from("patients")
      .select("id")
      .eq("id", data.patient_id)
      .maybeSingle();
    if (sErr) throw safeDbError(sErr);
    if (!still) throw new Error("Patient not found");
    throw new Error(PREFILL_STALE_MESSAGE);
  }

  const supabaseAdmin = await getAdmin();
  const actor = { id: context.userId, email: (context.claims.email as string) ?? null };
  await writeAudit(supabaseAdmin, {
    entity: "patients",
    recordId: row.id,
    action: "update",
    source: "app",
    actor,
    before: patient as Record<string, unknown>,
    after: row as Record<string, unknown>,
    changedFields: diffFields(
      patientPlain as Record<string, unknown>,
      decryptPatientRow(row) as Record<string, unknown>,
    ),
  });
  await writePatientFieldChanges(supabaseAdmin, {
    patientId: row.id,
    before: patientPlain as Record<string, unknown>,
    after: decryptPatientRow(row) as Record<string, unknown>,
    actor,
    sealValue: (v) => encryptField(v),
    sealedColumns: new Set<string>(PATIENT_ENCRYPTED_FIELDS),
  });

  return { applied_fields, skipped_fields, patient: decryptPatientRow(row) };
}
