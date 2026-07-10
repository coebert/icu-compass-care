CREATE TABLE public.microbiology_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  specimen_type TEXT NOT NULL,
  findings TEXT NOT NULL,
  result_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.microbiology_results TO authenticated;
GRANT ALL ON public.microbiology_results TO service_role;

ALTER TABLE public.microbiology_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical staff can view microbiology" ON public.microbiology_results
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert microbiology" ON public.microbiology_results
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update microbiology" ON public.microbiology_results
  FOR UPDATE TO authenticated USING (private.has_clinical_access(auth.uid())) WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete microbiology" ON public.microbiology_results
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));

CREATE INDEX idx_microbiology_results_patient ON public.microbiology_results(patient_id, result_at DESC);

CREATE TRIGGER update_microbiology_results_updated_at
  BEFORE UPDATE ON public.microbiology_results
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();