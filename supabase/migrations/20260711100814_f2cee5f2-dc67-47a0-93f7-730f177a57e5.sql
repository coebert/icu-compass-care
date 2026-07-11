ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS airway_type text,
  ADD COLUMN IF NOT EXISTS resp_support text[] NOT NULL DEFAULT '{}'::text[];