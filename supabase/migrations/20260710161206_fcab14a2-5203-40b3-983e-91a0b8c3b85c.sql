-- Patients are now identified by initials, age, and hospital number only.
-- Remove the discontinued dob and nhs_number columns so they no longer surface
-- in generated types or sync payloads for either app on the shared backend.
ALTER TABLE public.patients DROP COLUMN IF EXISTS dob;
ALTER TABLE public.patients DROP COLUMN IF EXISTS nhs_number;