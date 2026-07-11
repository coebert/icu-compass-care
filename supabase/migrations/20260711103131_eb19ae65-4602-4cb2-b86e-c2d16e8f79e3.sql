ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS renal_diuretics boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS renal_rrt boolean NOT NULL DEFAULT false;