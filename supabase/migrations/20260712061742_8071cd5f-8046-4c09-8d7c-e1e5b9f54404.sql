-- handover_acknowledgements: restrict to clinical staff
DROP POLICY IF EXISTS "Authenticated staff can add handover acks" ON public.handover_acknowledgements;
DROP POLICY IF EXISTS "Authenticated staff can delete handover acks" ON public.handover_acknowledgements;
DROP POLICY IF EXISTS "Authenticated staff can update handover acks" ON public.handover_acknowledgements;
DROP POLICY IF EXISTS "Authenticated staff can view handover acks" ON public.handover_acknowledgements;

CREATE POLICY "Clinical staff can view handover acks" ON public.handover_acknowledgements
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can add handover acks" ON public.handover_acknowledgements
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update handover acks" ON public.handover_acknowledgements
  FOR UPDATE TO authenticated USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete handover acks" ON public.handover_acknowledgements
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));

-- patient_lines: restrict to clinical staff
DROP POLICY IF EXISTS "Authenticated staff can add patient lines" ON public.patient_lines;
DROP POLICY IF EXISTS "Authenticated staff can delete patient lines" ON public.patient_lines;
DROP POLICY IF EXISTS "Authenticated staff can update patient lines" ON public.patient_lines;
DROP POLICY IF EXISTS "Authenticated staff can view patient lines" ON public.patient_lines;

CREATE POLICY "Clinical staff can view patient lines" ON public.patient_lines
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can add patient lines" ON public.patient_lines
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patient lines" ON public.patient_lines
  FOR UPDATE TO authenticated USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patient lines" ON public.patient_lines
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));

-- patient_tasks: scope policies to authenticated role
DROP POLICY IF EXISTS "Clinical staff can view patient tasks" ON public.patient_tasks;
DROP POLICY IF EXISTS "Clinical staff can insert patient tasks" ON public.patient_tasks;
DROP POLICY IF EXISTS "Clinical staff can update patient tasks" ON public.patient_tasks;
DROP POLICY IF EXISTS "Clinical staff can delete patient tasks" ON public.patient_tasks;

CREATE POLICY "Clinical staff can view patient tasks" ON public.patient_tasks
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patient tasks" ON public.patient_tasks
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patient tasks" ON public.patient_tasks
  FOR UPDATE TO authenticated USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patient tasks" ON public.patient_tasks
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));

-- patient_reviews: scope policies to authenticated role
DROP POLICY IF EXISTS "Clinical staff can view patient reviews" ON public.patient_reviews;
DROP POLICY IF EXISTS "Clinical staff can insert patient reviews" ON public.patient_reviews;
DROP POLICY IF EXISTS "Clinical staff can update patient reviews" ON public.patient_reviews;
DROP POLICY IF EXISTS "Clinical staff can delete patient reviews" ON public.patient_reviews;

CREATE POLICY "Clinical staff can view patient reviews" ON public.patient_reviews
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patient reviews" ON public.patient_reviews
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patient reviews" ON public.patient_reviews
  FOR UPDATE TO authenticated USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patient reviews" ON public.patient_reviews
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));