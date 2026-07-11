CREATE TABLE public.patient_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  device_type TEXT NOT NULL,
  site TEXT,
  laterality TEXT,
  size TEXT,
  inserted_on DATE,
  removed_on DATE,
  status TEXT NOT NULL DEFAULT 'in_situ',
  inserted_in_unit BOOLEAN NOT NULL DEFAULT true,
  indication TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_lines TO authenticated;
GRANT ALL ON public.patient_lines TO service_role;

ALTER TABLE public.patient_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view patient lines"
  ON public.patient_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated staff can add patient lines"
  ON public.patient_lines FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated staff can update patient lines"
  ON public.patient_lines FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated staff can delete patient lines"
  ON public.patient_lines FOR DELETE TO authenticated USING (true);

CREATE TRIGGER update_patient_lines_updated_at
  BEFORE UPDATE ON public.patient_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_patient_lines_patient_id ON public.patient_lines(patient_id);
CREATE INDEX idx_patient_lines_status ON public.patient_lines(status);