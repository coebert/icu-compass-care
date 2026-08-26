import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  decryptPatientRow,
  encryptPatientPayload,
  withCryptoColumns,
} from "@/lib/patient-crypto.server";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeAudit, writePatientFieldChanges } from "@/lib/audit";
import { getAdmin } from "@/lib/admin-db.server";
import {
  computeReferralPrefill,
  type ReferralPrefillSource,
} from "@/lib/referral-prefill";

const CANDIDATE_COLUMNS =
  "id, age, sex, current_ward, current_bed, referring_specialty, referral_received_at, status, reason_category, ceiling_of_care, resus_status, dnacpr_respect, admission_urgency, weight_kg, allergies, anticipated_interventions, infection_status, news2_score";

// Referrals synced from the partner app that a clinician can link a patient to.
export const listReferralCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("referrals")
      .select(CANDIDATE_COLUMNS)
      .is("deleted_at", null)
      .order("referral_received_at", { ascending: false })
      .limit(100);
    if (error) throw safeDbError(error);
    return data ?? [];
  });

// Dry-run: compute exactly which fields a referral would populate on a patient,
// including the proposed values, without mutating anything.
export const previewReferralPrefill = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ patient_id: z.string().uuid(), referral_id: z.string().uuid() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: patient, error: pErr } = await context.supabase
      .from("patients")
      .select(
        withCryptoColumns(
          "current_admission, current_management, tep_in_place, tep_details, dnacpr_decision, dnacpr_details",
        ),
      )
      .eq("id", data.patient_id)
      .maybeSingle();
    if (pErr) throw safeDbError(pErr);
    if (!patient) throw new Error("Patient not found");
    const patientPlain = decryptPatientRow(patient as unknown as Record<string, unknown>);

    const { data: ref, error: rErr } = await context.supabase
      .from("referrals")
      .select(
        "id, reason_category, ceiling_of_care, resus_status, dnacpr_respect, anticipated_interventions, allergies, weight_kg, admission_urgency",
      )
      .eq("id", data.referral_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (rErr) throw safeDbError(rErr);
    if (!ref) throw new Error("Referral not found");

    const source: ReferralPrefillSource = {
      reason_category: ref.reason_category ?? null,
      ceiling_of_care: ref.ceiling_of_care ?? null,
      resus_status: ref.resus_status ?? null,
      dnacpr_respect: ref.dnacpr_respect ?? null,
      anticipated_interventions:
        (ref.anticipated_interventions as string[] | null) ?? null,
      allergies: ref.allergies ?? null,
      weight_kg: ref.weight_kg ?? null,
      admission_urgency: ref.admission_urgency ?? null,
    };

    const plan = computeReferralPrefill(source, {
      current_admission: patient.current_admission,
      current_management: patient.current_management,
      tep_in_place: patient.tep_in_place,
      tep_details: patient.tep_details,
      dnacpr_decision: patient.dnacpr_decision,
      dnacpr_details: patient.dnacpr_details,
    });

    return {
      applied_fields: plan.applied_fields,
      skipped_fields: plan.skipped_fields,
      patch: plan.patch,
    };
  });

// Fill-blanks-only prefill of a patient record from a chosen referral.
export const prefillPatientFromReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ patient_id: z.string().uuid(), referral_id: z.string().uuid() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: patient, error: pErr } = await context.supabase
      .from("patients")
      .select("*")
      .eq("id", data.patient_id)
      .maybeSingle();
    if (pErr) throw safeDbError(pErr);
    if (!patient) throw new Error("Patient not found");

    const { data: ref, error: rErr } = await context.supabase
      .from("referrals")
      .select(
        "id, reason_category, ceiling_of_care, resus_status, dnacpr_respect, anticipated_interventions, allergies, weight_kg, admission_urgency",
      )
      .eq("id", data.referral_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (rErr) throw safeDbError(rErr);
    if (!ref) throw new Error("Referral not found");

    const source: ReferralPrefillSource = {
      reason_category: ref.reason_category ?? null,
      ceiling_of_care: ref.ceiling_of_care ?? null,
      resus_status: ref.resus_status ?? null,
      dnacpr_respect: ref.dnacpr_respect ?? null,
      anticipated_interventions:
        (ref.anticipated_interventions as string[] | null) ?? null,
      allergies: ref.allergies ?? null,
      weight_kg: ref.weight_kg ?? null,
      admission_urgency: ref.admission_urgency ?? null,
    };

    const { patch, applied_fields, skipped_fields } = computeReferralPrefill(source, {
      current_admission: patient.current_admission,
      current_management: patient.current_management,
      tep_in_place: patient.tep_in_place,
      tep_details: patient.tep_details,
      dnacpr_decision: patient.dnacpr_decision,
      dnacpr_details: patient.dnacpr_details,
    });

    // Always record the link so the card can surface its referral origin, even
    // if every mapped field was already populated.
    const updatePayload = { ...patch, source_referral_id: data.referral_id, updated_by: context.userId };

    const { data: row, error } = await context.supabase
      .from("patients")
      .update(updatePayload as never)
      .eq("id", data.patient_id)
      .select()
      .single();
    if (error) throw safeDbError(error);

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
    });
    await writePatientFieldChanges(supabaseAdmin, {
      patientId: row.id,
      before: patient as Record<string, unknown>,
      after: row as Record<string, unknown>,
      actor,
    });

    return { applied_fields, skipped_fields, patient: row };
  });
