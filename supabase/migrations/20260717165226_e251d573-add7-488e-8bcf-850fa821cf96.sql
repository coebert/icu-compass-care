
DROP POLICY IF EXISTS "Authenticated can read chart_days" ON public.chart_days;
DROP POLICY IF EXISTS "Authenticated can insert chart_days" ON public.chart_days;
DROP POLICY IF EXISTS "Authenticated can update chart_days" ON public.chart_days;

CREATE POLICY "Clinical staff can read chart_days" ON public.chart_days
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert chart_days" ON public.chart_days
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update chart_days" ON public.chart_days
  FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));

DROP POLICY IF EXISTS "Authenticated can read chart_hourly" ON public.chart_hourly;
DROP POLICY IF EXISTS "Authenticated can insert chart_hourly" ON public.chart_hourly;
DROP POLICY IF EXISTS "Authenticated can update chart_hourly" ON public.chart_hourly;

CREATE POLICY "Clinical staff can read chart_hourly" ON public.chart_hourly
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert chart_hourly" ON public.chart_hourly
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update chart_hourly" ON public.chart_hourly
  FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));
