ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS shared_with_partner boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shared_with_partner_at timestamptz,
  ADD COLUMN IF NOT EXISTS shared_with_partner_by uuid;

CREATE INDEX IF NOT EXISTS idx_patients_shared_with_partner
  ON public.patients (shared_with_partner)
  WHERE shared_with_partner;

-- Only administrators may flip the sharing marker. Clinicians can still edit
-- every other field; the bridge (service role) never changes this column
-- because it is not part of the bridge payload, so those writes leave the
-- flag unchanged and pass this guard.
CREATE OR REPLACE FUNCTION public.patients_guard_share_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.shared_with_partner IS DISTINCT FROM OLD.shared_with_partner THEN
    IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
      RAISE EXCEPTION 'Only administrators can change patient sharing'
        USING ERRCODE = '42501';
    END IF;
    NEW.shared_with_partner_at := now();
    NEW.shared_with_partner_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS patients_guard_share_flag_trg ON public.patients;
CREATE TRIGGER patients_guard_share_flag_trg
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.patients_guard_share_flag();