-- 1. Hospitals
CREATE TABLE public.hospitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hospitals TO authenticated;
GRANT ALL ON public.hospitals TO service_role;
ALTER TABLE public.hospitals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Clinical staff can view hospitals" ON public.hospitals
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Admins can insert hospitals" ON public.hospitals
  FOR INSERT TO authenticated WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update hospitals" ON public.hospitals
  FOR UPDATE TO authenticated USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can delete hospitals" ON public.hospitals
  FOR DELETE TO authenticated USING (private.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_hospitals_updated_at BEFORE UPDATE ON public.hospitals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. ICU units
CREATE TABLE public.icu_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  bed_capacity integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_icu_units_hospital ON public.icu_units(hospital_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.icu_units TO authenticated;
GRANT ALL ON public.icu_units TO service_role;
ALTER TABLE public.icu_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Clinical staff can view icu_units" ON public.icu_units
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Admins can insert icu_units" ON public.icu_units
  FOR INSERT TO authenticated WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update icu_units" ON public.icu_units
  FOR UPDATE TO authenticated USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can delete icu_units" ON public.icu_units
  FOR DELETE TO authenticated USING (private.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_icu_units_updated_at BEFORE UPDATE ON public.icu_units
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Per-user unit grants
CREATE TABLE public.user_unit_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.icu_units(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, unit_id)
);
CREATE INDEX idx_user_unit_access_user ON public.user_unit_access(user_id);
CREATE INDEX idx_user_unit_access_unit ON public.user_unit_access(unit_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_unit_access TO authenticated;
GRANT ALL ON public.user_unit_access TO service_role;
ALTER TABLE public.user_unit_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own unit access" ON public.user_unit_access
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can grant unit access" ON public.user_unit_access
  FOR INSERT TO authenticated WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update unit access" ON public.user_unit_access
  FOR UPDATE TO authenticated USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can revoke unit access" ON public.user_unit_access
  FOR DELETE TO authenticated USING (private.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_user_unit_access_updated_at BEFORE UPDATE ON public.user_unit_access
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Scope helper (security definer, avoids recursive RLS)
CREATE OR REPLACE FUNCTION private.has_unit_access(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL
     AND private.has_clinical_access(_user_id)
     AND (
       private.has_role(_user_id, 'admin')
       OR (
         _unit_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.user_unit_access ua
           WHERE ua.user_id = _user_id AND ua.unit_id = _unit_id
         )
       )
     );
$$;

-- 5. Patients gain a unit, seeded with Salisbury / Radnor ICU
ALTER TABLE public.patients ADD COLUMN unit_id uuid REFERENCES public.icu_units(id);

INSERT INTO public.hospitals (name, code) VALUES ('Salisbury District Hospital', 'SDH');
INSERT INTO public.icu_units (hospital_id, name, code)
  SELECT id, 'Radnor ICU', 'SDH-RADNOR' FROM public.hospitals WHERE code = 'SDH';

UPDATE public.patients SET unit_id = (SELECT id FROM public.icu_units WHERE code = 'SDH-RADNOR')
  WHERE unit_id IS NULL;

ALTER TABLE public.patients ALTER COLUMN unit_id SET NOT NULL;
CREATE INDEX idx_patients_unit ON public.patients(unit_id);

CREATE OR REPLACE FUNCTION private.can_access_patient(_user_id uuid, _patient_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = _patient_id
      AND private.has_unit_access(_user_id, p.unit_id)
  );
$$;

-- Grant every existing account access to the seeded unit
INSERT INTO public.user_unit_access (user_id, unit_id, reason)
  SELECT p.id, u.id, 'Initial migration: existing Radnor ICU staff'
  FROM public.profiles p
  CROSS JOIN public.icu_units u
  WHERE u.code = 'SDH-RADNOR'
  ON CONFLICT (user_id, unit_id) DO NOTHING;

-- 6. Patient policies now enforce unit scope
DROP POLICY "Clinical staff can view patients" ON public.patients;
DROP POLICY "Clinical staff can insert patients" ON public.patients;
DROP POLICY "Clinical staff can update patients" ON public.patients;
DROP POLICY "Clinical staff can delete patients" ON public.patients;
CREATE POLICY "Clinical staff can view patients in their units" ON public.patients
  FOR SELECT TO authenticated USING (private.has_unit_access(auth.uid(), unit_id));
CREATE POLICY "Clinical staff can insert patients in their units" ON public.patients
  FOR INSERT TO authenticated WITH CHECK (private.has_unit_access(auth.uid(), unit_id));
CREATE POLICY "Clinical staff can update patients in their units" ON public.patients
  FOR UPDATE TO authenticated USING (private.has_unit_access(auth.uid(), unit_id))
  WITH CHECK (private.has_unit_access(auth.uid(), unit_id));
CREATE POLICY "Clinical staff can delete patients in their units" ON public.patients
  FOR DELETE TO authenticated USING (private.has_unit_access(auth.uid(), unit_id));

-- 7. Child clinical tables inherit the patient's unit scope
DO $do$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patient_tasks','patient_events','patient_lines','patient_observations',
    'patient_reviews','patient_field_changes','investigations',
    'microbiology_results','handover_acknowledgements','chart_days'
  ] LOOP
    FOR p IN SELECT policyname FROM pg_policies
             WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY "Scoped staff can view %1$s" ON public.%1$I
        FOR SELECT TO authenticated
        USING (private.can_access_patient(auth.uid(), patient_id))$f$, t);
    EXECUTE format($f$
      CREATE POLICY "Scoped staff can insert %1$s" ON public.%1$I
        FOR INSERT TO authenticated
        WITH CHECK (private.can_access_patient(auth.uid(), patient_id))$f$, t);
    EXECUTE format($f$
      CREATE POLICY "Scoped staff can update %1$s" ON public.%1$I
        FOR UPDATE TO authenticated
        USING (private.can_access_patient(auth.uid(), patient_id))
        WITH CHECK (private.can_access_patient(auth.uid(), patient_id))$f$, t);
  END LOOP;
END
$do$;

-- Deletes: allowed for the tables that previously allowed them, still unit-scoped
CREATE POLICY "Scoped staff can delete patient_tasks" ON public.patient_tasks
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete patient_events" ON public.patient_events
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete patient_lines" ON public.patient_lines
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete patient_observations" ON public.patient_observations
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete patient_reviews" ON public.patient_reviews
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete investigations" ON public.investigations
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete microbiology_results" ON public.microbiology_results
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "No one can delete chart_days" ON public.chart_days
  FOR DELETE TO authenticated USING (false);
CREATE POLICY "No one can delete patient_field_changes" ON public.patient_field_changes
  FOR DELETE TO authenticated USING (false);
CREATE POLICY "No one can delete handover_acknowledgements" ON public.handover_acknowledgements
  FOR DELETE TO authenticated USING (false);

-- 8. chart_hourly follows its chart day's patient
DO $do$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'chart_hourly' LOOP
    EXECUTE format('DROP POLICY %I ON public.chart_hourly', p.policyname);
  END LOOP;
END
$do$;
CREATE POLICY "Scoped staff can view chart_hourly" ON public.chart_hourly
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.chart_days d
    WHERE d.id = chart_hourly.chart_day_id
      AND private.can_access_patient(auth.uid(), d.patient_id)));
CREATE POLICY "Scoped staff can insert chart_hourly" ON public.chart_hourly
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.chart_days d
    WHERE d.id = chart_hourly.chart_day_id
      AND private.can_access_patient(auth.uid(), d.patient_id)));
CREATE POLICY "Scoped staff can update chart_hourly" ON public.chart_hourly
  FOR UPDATE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.chart_days d
    WHERE d.id = chart_hourly.chart_day_id
      AND private.can_access_patient(auth.uid(), d.patient_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.chart_days d
    WHERE d.id = chart_hourly.chart_day_id
      AND private.can_access_patient(auth.uid(), d.patient_id)));
CREATE POLICY "No one can delete chart_hourly" ON public.chart_hourly
  FOR DELETE TO authenticated USING (false);