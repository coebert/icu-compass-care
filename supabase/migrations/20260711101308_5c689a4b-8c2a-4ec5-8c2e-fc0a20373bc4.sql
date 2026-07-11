ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS vasoactive_agents text[] NOT NULL DEFAULT '{}'::text[];