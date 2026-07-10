-- Add nullable age column to patients for compatibility with the new UI/validation.
-- Nullable so existing records (which have no age) continue to load without error.
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS age smallint;

-- Range guard: allow NULL (legacy rows) but constrain any provided value to a plausible clinical range.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_age_range_chk'
  ) THEN
    ALTER TABLE public.patients
      ADD CONSTRAINT patients_age_range_chk
      CHECK (age IS NULL OR (age >= 0 AND age <= 130));
  END IF;
END $$;

-- Best-effort backfill: derive age from dob for legacy rows that still have a date of birth.
UPDATE public.patients
SET age = date_part('year', age(now(), dob))::smallint
WHERE age IS NULL
  AND dob IS NOT NULL
  AND date_part('year', age(now(), dob)) BETWEEN 0 AND 130;