-- Tighten RLS on patient_events, patient_reviews, patient_tasks to require
-- clinical access, matching patients / investigations / referrals.

-- patient_events
DROP POLICY IF EXISTS "Authenticated staff can view patient events" ON public.patient_events;
DROP POLICY IF EXISTS "Authenticated staff can add patient events" ON public.patient_events;
DROP POLICY IF EXISTS "Authenticated staff can update patient events" ON public.patient_events;
DROP POLICY IF EXISTS "Authenticated staff can delete patient events" ON public.patient_events;

CREATE POLICY "Clinical staff can view patient events" ON public.patient_events
  FOR SELECT USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patient events" ON public.patient_events
  FOR INSERT WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patient events" ON public.patient_events
  FOR UPDATE USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patient events" ON public.patient_events
  FOR DELETE USING (private.has_clinical_access(auth.uid()));

-- patient_reviews
DROP POLICY IF EXISTS "Authenticated staff can view patient reviews" ON public.patient_reviews;
DROP POLICY IF EXISTS "Authenticated staff can add patient reviews" ON public.patient_reviews;
DROP POLICY IF EXISTS "Authenticated staff can update patient reviews" ON public.patient_reviews;
DROP POLICY IF EXISTS "Authenticated staff can delete patient reviews" ON public.patient_reviews;

CREATE POLICY "Clinical staff can view patient reviews" ON public.patient_reviews
  FOR SELECT USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patient reviews" ON public.patient_reviews
  FOR INSERT WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patient reviews" ON public.patient_reviews
  FOR UPDATE USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patient reviews" ON public.patient_reviews
  FOR DELETE USING (private.has_clinical_access(auth.uid()));

-- patient_tasks
DROP POLICY IF EXISTS "Authenticated staff can view patient tasks" ON public.patient_tasks;
DROP POLICY IF EXISTS "Authenticated staff can add patient tasks" ON public.patient_tasks;
DROP POLICY IF EXISTS "Authenticated staff can update patient tasks" ON public.patient_tasks;
DROP POLICY IF EXISTS "Authenticated staff can delete patient tasks" ON public.patient_tasks;

CREATE POLICY "Clinical staff can view patient tasks" ON public.patient_tasks
  FOR SELECT USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patient tasks" ON public.patient_tasks
  FOR INSERT WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patient tasks" ON public.patient_tasks
  FOR UPDATE USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patient tasks" ON public.patient_tasks
  FOR DELETE USING (private.has_clinical_access(auth.uid()));