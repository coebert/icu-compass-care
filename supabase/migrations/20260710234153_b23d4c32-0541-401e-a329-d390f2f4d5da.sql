ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS systems_resp text,
  ADD COLUMN IF NOT EXISTS systems_cvs text,
  ADD COLUMN IF NOT EXISTS systems_neuro text,
  ADD COLUMN IF NOT EXISTS systems_renal text,
  ADD COLUMN IF NOT EXISTS systems_gastro text,
  ADD COLUMN IF NOT EXISTS systems_haem text,
  ADD COLUMN IF NOT EXISTS systems_micro text,
  ADD COLUMN IF NOT EXISTS systems_other text;