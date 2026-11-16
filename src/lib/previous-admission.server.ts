import type { SupabaseClient } from "@supabase/supabase-js";
import { safeDbError } from "@/lib/db-error";
import {
  decryptPatientRows,
  patientLookupHash,
  withCryptoColumns,
} from "@/lib/patient-crypto.server";
import {
  normaliseHospitalNumber,
  verifiedPreviousAdmissions,
  type PreviousAdmission,
} from "@/lib/previous-admission";

/**
 * Previous (discharged/died) admissions the caller may read (RLS, unit scope)
 * whose hospital number exactly matches. No hospital number => no lookup:
 * initials + age are never used to find or suggest a person.
 */
export async function findVerifiedPreviousAdmissions(
  supabase: SupabaseClient,
  input: { hospital_number?: string; exclude_id?: string },
): Promise<PreviousAdmission[]> {
  const mrn = normaliseHospitalNumber(input.hospital_number);
  if (!mrn) return [];
  const hash = patientLookupHash(mrn);
  if (!hash) return [];

  let query = supabase
    .from("patients")
    .select(
      withCryptoColumns(
        "id, full_name, hospital_number, age, status, admission_date, discharge_date, date_of_death, past_medical_history, tep_in_place, tep_details, dnacpr_decision, dnacpr_details, dnacpr_date, updated_at",
      ),
    )
    .eq("hospital_number_hash", hash)
    .in("status", ["discharged", "died"])
    .order("updated_at", { ascending: false })
    .limit(5);
  if (input.exclude_id) query = query.neq("id", input.exclude_id);

  const { data: rows, error } = await query;
  if (error) throw safeDbError(error);
  const decrypted = decryptPatientRows(
    rows as unknown as Array<Record<string, unknown>> | null,
  ) as unknown as PreviousAdmission[];
  // The hash only narrows the search; the decrypted number must match exactly.
  return verifiedPreviousAdmissions(mrn, decrypted);
}
