CREATE OR REPLACE FUNCTION public.patients_guard_share_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.shared_with_partner IS DISTINCT FROM OLD.shared_with_partner THEN
    IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'Only administrators can change patient sharing'
        USING ERRCODE = '42501';
    END IF;
    NEW.shared_with_partner_at := now();
    NEW.shared_with_partner_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;