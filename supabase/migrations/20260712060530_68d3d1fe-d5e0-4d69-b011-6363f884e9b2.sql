ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS tep_exclusions text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.patients.tep_exclusions IS
  'Structured treatment-escalation-plan exclusions: interventions the patient should NOT receive. Allowed keys: hfno, niv, ivv, cvvh, vasopressors.';