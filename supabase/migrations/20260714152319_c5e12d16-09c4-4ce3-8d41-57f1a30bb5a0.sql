ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS wardable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wardable_at timestamptz,
  ADD COLUMN IF NOT EXISTS wardable_by uuid;

CREATE INDEX IF NOT EXISTS patients_wardable_at_idx ON public.patients (wardable_at) WHERE wardable = true;