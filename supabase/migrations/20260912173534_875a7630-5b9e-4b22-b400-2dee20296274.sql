ALTER TABLE public.patient_tasks
  ADD COLUMN IF NOT EXISTS source_checklist_id uuid REFERENCES public.patient_checklists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_item_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_tasks_checklist_item
  ON public.patient_tasks (source_checklist_id, source_item_key)
  WHERE source_checklist_id IS NOT NULL AND source_item_key IS NOT NULL;