CREATE TABLE public.patient_observations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  recorded_by UUID,
  hr INTEGER,
  sbp INTEGER,
  dbp INTEGER,
  map INTEGER,
  spo2 INTEGER,
  fio2 NUMERIC,
  rr INTEGER,
  temp NUMERIC,
  gcs INTEGER,
  lactate NUMERIC,
  vent_mode TEXT,
  peep INTEGER,
  vt INTEGER,
  vasopressor TEXT,
  vasopressor_dose NUMERIC,
  urine_ml INTEGER,
  fluid_in_ml INTEGER,
  fluid_out_ml INTEGER,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_observations TO authenticated;
GRANT ALL ON public.patient_observations TO service_role;

ALTER TABLE public.patient_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view observations"
  ON public.patient_observations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated staff can add observations"
  ON public.patient_observations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated staff can update observations"
  ON public.patient_observations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated staff can delete observations"
  ON public.patient_observations FOR DELETE TO authenticated USING (true);

CREATE INDEX idx_patient_observations_patient_id ON public.patient_observations(patient_id);
CREATE INDEX idx_patient_observations_recorded_at ON public.patient_observations(recorded_at);

CREATE TRIGGER update_patient_observations_updated_at
  BEFORE UPDATE ON public.patient_observations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();