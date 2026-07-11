CREATE TABLE public.patient_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  specialty TEXT NOT NULL,
  review TEXT,
  plan TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_reviews TO authenticated;
GRANT ALL ON public.patient_reviews TO service_role;

ALTER TABLE public.patient_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view patient reviews"
  ON public.patient_reviews FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated staff can add patient reviews"
  ON public.patient_reviews FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated staff can update patient reviews"
  ON public.patient_reviews FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated staff can delete patient reviews"
  ON public.patient_reviews FOR DELETE TO authenticated USING (true);

CREATE INDEX idx_patient_reviews_patient_id ON public.patient_reviews(patient_id);

CREATE TRIGGER update_patient_reviews_updated_at
  BEFORE UPDATE ON public.patient_reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();