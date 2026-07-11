CREATE TABLE public.patient_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_tasks TO authenticated;
GRANT ALL ON public.patient_tasks TO service_role;

ALTER TABLE public.patient_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view patient tasks"
  ON public.patient_tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated staff can add patient tasks"
  ON public.patient_tasks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated staff can update patient tasks"
  ON public.patient_tasks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated staff can delete patient tasks"
  ON public.patient_tasks FOR DELETE TO authenticated USING (true);

CREATE INDEX idx_patient_tasks_patient_id ON public.patient_tasks(patient_id);

CREATE TRIGGER update_patient_tasks_updated_at
  BEFORE UPDATE ON public.patient_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();