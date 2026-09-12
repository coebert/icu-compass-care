CREATE TABLE IF NOT EXISTS public.checklist_template_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES public.checklist_templates(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'update' CHECK (kind IN ('create', 'update')),
  name text NOT NULL,
  description text,
  specialty text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by uuid,
  proposed_by_email text,
  reviewed_by uuid,
  reviewed_by_email text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.checklist_template_proposals TO authenticated;
GRANT ALL ON public.checklist_template_proposals TO service_role;

ALTER TABLE public.checklist_template_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view checklist proposals"
  ON public.checklist_template_proposals FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid()) OR private.is_config_admin(auth.uid()) OR private.is_auditor(auth.uid()));

CREATE POLICY "Staff can propose checklist changes"
  ON public.checklist_template_proposals FOR INSERT TO authenticated
  WITH CHECK (proposed_by = auth.uid() AND status = 'pending'
              AND (private.has_clinical_access(auth.uid()) OR private.is_config_admin(auth.uid())));

CREATE POLICY "Administrators can review checklist proposals"
  ON public.checklist_template_proposals FOR UPDATE TO authenticated
  USING (private.is_config_admin(auth.uid()))
  WITH CHECK (private.is_config_admin(auth.uid()));

CREATE TRIGGER trg_checklist_template_proposals_updated_at
  BEFORE UPDATE ON public.checklist_template_proposals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_checklist_proposals_status
  ON public.checklist_template_proposals (status, created_at DESC);