CREATE TABLE public.patient_field_changes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  field_name text NOT NULL CHECK (field_name IN ('initials', 'age', 'hospital_number')),
  old_value text,
  new_value text,
  changed_by uuid,
  changed_by_email text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_patient_field_changes_patient ON public.patient_field_changes (patient_id, changed_at DESC);

GRANT SELECT ON public.patient_field_changes TO authenticated;
GRANT ALL ON public.patient_field_changes TO service_role;

ALTER TABLE public.patient_field_changes ENABLE ROW LEVEL SECURITY;

-- Clinical staff / admins can read the field-change history.
CREATE POLICY "Clinical staff can view patient field changes"
ON public.patient_field_changes
FOR SELECT
TO authenticated
USING (private.has_clinical_access(auth.uid()));