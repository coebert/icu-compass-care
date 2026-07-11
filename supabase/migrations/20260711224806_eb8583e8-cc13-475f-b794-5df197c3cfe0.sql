-- Recreate patient_events policies scoped to the `authenticated` role
-- (previously targeted the broader `public` role). The clinical-access
-- check is unchanged, so effective access is identical.

DROP POLICY IF EXISTS "Clinical staff can view patient events" ON public.patient_events;
DROP POLICY IF EXISTS "Clinical staff can insert patient events" ON public.patient_events;
DROP POLICY IF EXISTS "Clinical staff can update patient events" ON public.patient_events;
DROP POLICY IF EXISTS "Clinical staff can delete patient events" ON public.patient_events;

CREATE POLICY "Clinical staff can view patient events"
  ON public.patient_events FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical staff can insert patient events"
  ON public.patient_events FOR INSERT TO authenticated
  WITH CHECK (private.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical staff can update patient events"
  ON public.patient_events FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical staff can delete patient events"
  ON public.patient_events FOR DELETE TO authenticated
  USING (private.has_clinical_access(auth.uid()));