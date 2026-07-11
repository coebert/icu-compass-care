ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS sedative_agents text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS pca_agents text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS regional_analgesia text[] NOT NULL DEFAULT '{}'::text[];