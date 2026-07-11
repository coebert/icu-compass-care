DROP POLICY IF EXISTS "Authenticated staff can view observations" ON public.patient_observations;
DROP POLICY IF EXISTS "Authenticated staff can add observations" ON public.patient_observations;
DROP POLICY IF EXISTS "Authenticated staff can update observations" ON public.patient_observations;
DROP POLICY IF EXISTS "Authenticated staff can delete observations" ON public.patient_observations;

CREATE POLICY "Clinicians can view observations"
  ON public.patient_observations FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinicians can add observations"
  ON public.patient_observations FOR INSERT TO authenticated
  WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinicians can update observations"
  ON public.patient_observations FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinicians can delete observations"
  ON public.patient_observations FOR DELETE TO authenticated
  USING (private.has_clinical_access(auth.uid()));