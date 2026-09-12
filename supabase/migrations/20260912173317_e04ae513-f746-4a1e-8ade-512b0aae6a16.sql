CREATE TABLE public.checklist_template_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES public.checklist_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name text NOT NULL,
  description text,
  specialty text,
  items jsonb NOT NULL,
  note text,
  changed_by uuid,
  changed_by_email text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE INDEX idx_checklist_template_versions_template
  ON public.checklist_template_versions (template_id, version DESC);

GRANT SELECT ON public.checklist_template_versions TO authenticated;
GRANT ALL ON public.checklist_template_versions TO service_role;

ALTER TABLE public.checklist_template_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view checklist template history"
  ON public.checklist_template_versions FOR SELECT TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.checklist_templates_record_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _next integer;
  _email text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.specialty IS NOT DISTINCT FROM OLD.specialty
     AND NEW.items IS NOT DISTINCT FROM OLD.items THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(max(version), 0) + 1 INTO _next
    FROM public.checklist_template_versions WHERE template_id = NEW.id;

  SELECT email INTO _email FROM auth.users WHERE id = auth.uid();

  INSERT INTO public.checklist_template_versions(
    template_id, version, name, description, specialty, items, changed_by, changed_by_email
  ) VALUES (
    NEW.id, _next, NEW.name, NEW.description, NEW.specialty, NEW.items, auth.uid(), _email
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER checklist_templates_record_version_trg
  AFTER INSERT OR UPDATE ON public.checklist_templates
  FOR EACH ROW EXECUTE FUNCTION public.checklist_templates_record_version();