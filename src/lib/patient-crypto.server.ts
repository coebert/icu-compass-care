/**
 * Transparent encryption layer for the patients table (server-only).
 *
 * Every write goes through `encryptPatientPayload` and every read through
 * `decryptPatientRow`, so application code keeps working with plain field names
 * (`current_management`, `hospital_number`, ...) while the database only ever
 * holds AES-256-GCM ciphertext in the matching `*_enc` column plus keyed-hash
 * fingerprints in `*_hash` for lookup.
 */

import { decryptFieldSafe, encryptField, hashIdentifier } from "@/lib/crypto.server";

/** Patient identifiers — encrypted, and keyed-hashed for exact-match lookup. */
export const PATIENT_IDENTIFIER_FIELDS = [
  "full_name", // initials only (never a full name — see project policy)
  "hospital_number",
  "nok_name",
  "nok_relationship",
  "nok_contact",
] as const;

/** Identifiers that also get an HMAC lookup column. */
export const PATIENT_HASHED_FIELDS = ["full_name", "hospital_number"] as const;

/** Clinical narrative fields — encrypted at rest. */
export const PATIENT_NARRATIVE_FIELDS = [
  "past_medical_history",
  "current_admission",
  "current_management",
  "outstanding_tasks",
  "tep_details",
  "dnacpr_details",
  "systems_resp",
  "systems_cvs",
  "systems_neuro",
  "systems_renal",
  "systems_gastro",
  "systems_haem",
  "systems_micro",
  "systems_other",
  "nursing_handover",
  "physio_handover",
  "salt_handover",
  "discharge_destination",
] as const;

export const PATIENT_ENCRYPTED_FIELDS = [
  ...PATIENT_IDENTIFIER_FIELDS,
  ...PATIENT_NARRATIVE_FIELDS,
] as const;

export type PatientEncryptedField = (typeof PATIENT_ENCRYPTED_FIELDS)[number];

/** Columns to append to any explicit `select(...)` that needs these fields. */
export const PATIENT_CRYPTO_COLUMNS = [
  ...PATIENT_ENCRYPTED_FIELDS.map((f) => `${f}_enc`),
  ...PATIENT_HASHED_FIELDS.map((f) => `${f}_hash`),
].join(", ");

/** Add the crypto columns to a comma-separated select list. */
export function withCryptoColumns(select: string): string {
  return `${select}, ${PATIENT_CRYPTO_COLUMNS}`;
}

type Row = Record<string, unknown>;

/**
 * Turn an application-shaped write payload into the database shape:
 * plaintext columns are emptied, `*_enc` holds the ciphertext and `*_hash` the
 * keyed lookup fingerprint. Fields absent from the payload are left untouched
 * so partial updates stay partial.
 */
export function encryptPatientPayload<T extends Row>(payload: T): Row {
  const out: Row = { ...payload };
  for (const field of PATIENT_ENCRYPTED_FIELDS) {
    if (!(field in out)) continue;
    const value = out[field] as string | null | undefined;
    out[`${field}_enc`] = encryptField(value);
    // The readable column is never populated again.
    out[field] = null;
  }
  for (const field of PATIENT_HASHED_FIELDS) {
    if (!(field in payload)) continue;
    out[`${field}_hash`] = hashIdentifier(payload[field] as string | null | undefined);
  }
  return out;
}

/**
 * Reverse of the above: expose readable values under their plain field names
 * and drop the ciphertext/fingerprint columns so they can never leak into an
 * API response, PDF, snapshot or client payload.
 *
 * Rows not yet backfilled still carry a plaintext value; it is preserved.
 */
export function decryptPatientRow<T extends Row>(row: T): T {
  const out: Row = { ...row };
  for (const field of PATIENT_ENCRYPTED_FIELDS) {
    const encKey = `${field}_enc`;
    if (encKey in out) {
      const enc = out[encKey] as string | null | undefined;
      if (enc) out[field] = decryptFieldSafe(enc);
      else if (out[field] === undefined) out[field] = null;
      delete out[encKey];
    }
  }
  for (const field of PATIENT_HASHED_FIELDS) delete out[`${field}_hash`];
  return out as T;
}

export function decryptPatientRows<T extends Row>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).map((r) => decryptPatientRow(r));
}

/** Keyed-hash value for looking a patient up by an identifier. */
export function patientLookupHash(value: string | null | undefined): string | null {
  return hashIdentifier(value);
}
