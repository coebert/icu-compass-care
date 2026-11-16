import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { decryptPatientRow, withCryptoColumns } from "@/lib/patient-crypto.server";
import { applyReferralPrefill } from "@/lib/referral-prefill.server";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeReferralPrefill,
  REFERRAL_PREFILL_COLUMNS,
  type ReferralPrefillSource,
} from "@/lib/referral-prefill";

// Version strings come straight back from a preview; bounded and opaque.
const versionString = z.string().min(1).max(64);

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
    z.object({ patient_id: z.string().uuid(), referral_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: patient, error: pErr } = await context.supabase
      .from("patients")
      .select(
        withCryptoColumns(
          "updated_at, current_admission, current_management, tep_in_place, tep_details, dnacpr_decision, dnacpr_details",
        ),
      )
      .eq("id", data.patient_id)
      .maybeSingle();
    if (pErr) throw safeDbError(pErr);
    if (!patient) throw new Error("Patient not found");
    const patientPlain = decryptPatientRow(patient as unknown as Record<string, unknown>);

    const { data: ref, error: rErr } = await context.supabase
      .from("referrals")
      .select(REFERRAL_PREFILL_COLUMNS)
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
      anticipated_interventions: (ref.anticipated_interventions as string[] | null) ?? null,
      allergies: ref.allergies ?? null,
      weight_kg: ref.weight_kg ?? null,
      admission_urgency: ref.admission_urgency ?? null,
    };

    const plan = computeReferralPrefill(source, {
      current_admission: patientPlain.current_admission as string | null,
      current_management: patientPlain.current_management as string | null,
      tep_in_place: patientPlain.tep_in_place as boolean | null,
      tep_details: patientPlain.tep_details as string | null,
      dnacpr_decision: patientPlain.dnacpr_decision as boolean | null,
      dnacpr_details: patientPlain.dnacpr_details as string | null,
    });

    return {
      applied_fields: plan.applied_fields,
      skipped_fields: plan.skipped_fields,
      patch: plan.patch,
      // Echoed back on confirm so a stale preview can't be applied.
      patient_updated_at: String((patient as unknown as { updated_at: string }).updated_at),
      referral_updated_at: (ref.updated_at as string | null) ?? null,
    };
  });

// Fill-blanks-only prefill of a patient record from a chosen referral.
// Compare-and-set: applies only if the patient (and referral) are exactly the
// versions the user previewed; otherwise nothing is written.
export const prefillPatientFromReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        patient_id: z.string().uuid(),
        referral_id: z.string().uuid(),
        expected_patient_updated_at: versionString,
        expected_referral_updated_at: versionString.nullable(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => applyReferralPrefill(context, data));
