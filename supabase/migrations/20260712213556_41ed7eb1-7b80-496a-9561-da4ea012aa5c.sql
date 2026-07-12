-- New patients default to being shared with the partner app
ALTER TABLE public.patients ALTER COLUMN shared_with_partner SET DEFAULT true;

-- Turn on sharing for all existing patients. The admin-only guard trigger
-- blocks changes to this flag when there is no admin session, so disable it
-- for this one-off backfill and re-enable it afterwards.
ALTER TABLE public.patients DISABLE TRIGGER patients_guard_share_flag_trg;

UPDATE public.patients
   SET shared_with_partner = true,
       shared_with_partner_at = now()
 WHERE shared_with_partner IS DISTINCT FROM true;

ALTER TABLE public.patients ENABLE TRIGGER patients_guard_share_flag_trg;