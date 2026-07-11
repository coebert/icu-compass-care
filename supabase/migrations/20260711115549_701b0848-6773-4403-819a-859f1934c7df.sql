ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS source_referral_id uuid;
CREATE INDEX IF NOT EXISTS idx_patients_source_referral_id ON public.patients (source_referral_id);