CREATE TABLE public.patient_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  description TEXT,
  event_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_events TO authenticated;
GRANT ALL ON public.patient_events TO service_role;

ALTER TABLE public.patient_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view patient events"
  ON public.patient_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated staff can add patient events"
  ON public.patient_events FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated staff can update patient events"
  ON public.patient_events FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated staff can delete patient events"
  ON public.patient_events FOR DELETE TO authenticated USING (true);

CREATE INDEX idx_patient_events_patient_id ON public.patient_events(patient_id);

CREATE TRIGGER update_patient_events_updated_at
  BEFORE UPDATE ON public.patient_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();