ALTER TABLE public.patients
ADD COLUMN IF NOT EXISTS isolation_required boolean NOT NULL DEFAULT false;