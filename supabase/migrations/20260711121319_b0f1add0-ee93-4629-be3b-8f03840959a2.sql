ALTER TABLE public.patient_tasks
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'routine',
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'job',
  ADD COLUMN IF NOT EXISTS owner TEXT,
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.patient_tasks
  DROP CONSTRAINT IF EXISTS patient_tasks_priority_check;
ALTER TABLE public.patient_tasks
  ADD CONSTRAINT patient_tasks_priority_check
  CHECK (priority IN ('routine', 'urgent', 'critical'));

ALTER TABLE public.patient_tasks
  DROP CONSTRAINT IF EXISTS patient_tasks_category_check;
ALTER TABLE public.patient_tasks
  ADD CONSTRAINT patient_tasks_category_check
  CHECK (category IN ('job', 'ward_round'));

CREATE INDEX IF NOT EXISTS idx_patient_tasks_due_at ON public.patient_tasks(due_at);