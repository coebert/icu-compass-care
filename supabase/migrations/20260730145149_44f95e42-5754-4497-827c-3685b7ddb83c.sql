ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS nursing_handover text,
  ADD COLUMN IF NOT EXISTS physio_handover text,
  ADD COLUMN IF NOT EXISTS salt_handover text;