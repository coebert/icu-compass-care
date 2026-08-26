-- 1. Key escrow table (server-only; holds the master key wrapped under the admin recovery key)
CREATE TABLE public.crypto_key_escrow (
  key_id text PRIMARY KEY,
  wrapped_key text NOT NULL,
  algo text NOT NULL DEFAULT 'aes-256-gcm',
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.crypto_key_escrow TO service_role;
ALTER TABLE public.crypto_key_escrow ENABLE ROW LEVEL SECURITY;
-- No policies: fail-closed. Reachable only by server code using the service role,
-- which bypasses RLS. anon/authenticated have no grants and no policies.

CREATE TRIGGER trg_crypto_key_escrow_updated_at
BEFORE UPDATE ON public.crypto_key_escrow
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Encrypted identifier columns + keyed-hash lookup columns
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS full_name_enc text,
  ADD COLUMN IF NOT EXISTS full_name_hash text,
  ADD COLUMN IF NOT EXISTS hospital_number_enc text,
  ADD COLUMN IF NOT EXISTS hospital_number_hash text,
  ADD COLUMN IF NOT EXISTS nok_name_enc text,
  ADD COLUMN IF NOT EXISTS nok_relationship_enc text,
  ADD COLUMN IF NOT EXISTS nok_contact_enc text;

-- 3. Encrypted clinical narrative columns
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS past_medical_history_enc text,
  ADD COLUMN IF NOT EXISTS current_admission_enc text,
  ADD COLUMN IF NOT EXISTS current_management_enc text,
  ADD COLUMN IF NOT EXISTS outstanding_tasks_enc text,
  ADD COLUMN IF NOT EXISTS tep_details_enc text,
  ADD COLUMN IF NOT EXISTS dnacpr_details_enc text,
  ADD COLUMN IF NOT EXISTS systems_resp_enc text,
  ADD COLUMN IF NOT EXISTS systems_cvs_enc text,
  ADD COLUMN IF NOT EXISTS systems_neuro_enc text,
  ADD COLUMN IF NOT EXISTS systems_renal_enc text,
  ADD COLUMN IF NOT EXISTS systems_gastro_enc text,
  ADD COLUMN IF NOT EXISTS systems_haem_enc text,
  ADD COLUMN IF NOT EXISTS systems_micro_enc text,
  ADD COLUMN IF NOT EXISTS systems_other_enc text,
  ADD COLUMN IF NOT EXISTS nursing_handover_enc text,
  ADD COLUMN IF NOT EXISTS physio_handover_enc text,
  ADD COLUMN IF NOT EXISTS salt_handover_enc text,
  ADD COLUMN IF NOT EXISTS discharge_destination_enc text;

-- 4. Plaintext initials column becomes optional so it can be cleared after backfill
ALTER TABLE public.patients ALTER COLUMN full_name DROP NOT NULL;

-- 5. Keyed-hash lookup indexes (exact-match lookup / de-duplication without plaintext)
CREATE INDEX IF NOT EXISTS patients_hospital_number_hash_idx
  ON public.patients (hospital_number_hash);
CREATE INDEX IF NOT EXISTS patients_full_name_hash_idx
  ON public.patients (full_name_hash);

COMMENT ON COLUMN public.patients.hospital_number_hash IS
  'HMAC-SHA256 (keyed with CLINICAL_HASH_KEY) fingerprint of the hospital number. Used for exact-match lookup and de-duplication; not reversible.';
COMMENT ON COLUMN public.patients.full_name_hash IS
  'HMAC-SHA256 (keyed with CLINICAL_HASH_KEY) fingerprint of the patient initials. Lookup only; not reversible.';