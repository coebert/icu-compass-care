ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS parent_specialty text,
  ADD COLUMN IF NOT EXISTS specialty_consultant text;