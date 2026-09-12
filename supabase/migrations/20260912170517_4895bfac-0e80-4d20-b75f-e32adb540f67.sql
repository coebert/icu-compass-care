CREATE TABLE public.checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  specialty text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  is_builtin boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.checklist_templates TO authenticated;
GRANT ALL ON public.checklist_templates TO service_role;
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view checklist templates" ON public.checklist_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Clinical staff can add checklist templates" ON public.checklist_templates
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can edit checklist templates" ON public.checklist_templates
  FOR UPDATE TO authenticated USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can remove custom checklist templates" ON public.checklist_templates
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()) AND is_builtin = false);

CREATE TRIGGER trg_checklist_templates_updated_at BEFORE UPDATE ON public.checklist_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.patient_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  template_id uuid REFERENCES public.checklist_templates(id) ON DELETE SET NULL,
  template_key text NOT NULL,
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_by uuid REFERENCES auth.users(id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX patient_checklists_patient_idx ON public.patient_checklists (patient_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_checklists TO authenticated;
GRANT ALL ON public.patient_checklists TO service_role;
ALTER TABLE public.patient_checklists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Scoped staff and Trust admins can view patient_checklists" ON public.patient_checklists
  FOR SELECT TO authenticated USING (private.can_view_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can insert patient_checklists" ON public.patient_checklists
  FOR INSERT TO authenticated WITH CHECK (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can update patient_checklists" ON public.patient_checklists
  FOR UPDATE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id))
  WITH CHECK (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can delete patient_checklists" ON public.patient_checklists
  FOR DELETE TO authenticated USING (private.can_access_patient(auth.uid(), patient_id));

CREATE TRIGGER trg_patient_checklists_updated_at BEFORE UPDATE ON public.patient_checklists
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.checklist_templates (key, name, description, specialty, is_builtin, items) VALUES
('fasterhug', 'FASTERHUG', 'Daily critical care bundle: Feeding, Analgesia, Sedation, Thromboprophylaxis, Elevate head, Rehabilitation/Ulcer prophylaxis, Head-up/Hyperglycaemia, Glycaemic control.', 'General critical care', true, '[
  {"key":"feeding","label":"F — Feeding","hint":"Enteral or parenteral nutrition prescribed and tolerated"},
  {"key":"analgesia","label":"A — Analgesia","hint":"Pain assessed and adequately controlled"},
  {"key":"sedation","label":"S — Sedation","hint":"Target RASS set; daily sedation hold considered"},
  {"key":"thromboprophylaxis","label":"T — Thromboprophylaxis","hint":"Pharmacological or mechanical VTE prophylaxis"},
  {"key":"head_up","label":"E — Elevate head of bed 30°","hint":"Reduces ventilator-associated pneumonia risk"},
  {"key":"ulcer_prophylaxis","label":"R — Stress ulcer prophylaxis","hint":"GI protection where indicated"},
  {"key":"hyperglycaemia","label":"H — Hyperglycaemia control","hint":"Glycaemic target reviewed"},
  {"key":"ulcer_skin","label":"U — Ulcer / skin care","hint":"Pressure areas reviewed, repositioning plan"},
  {"key":"glucose_review","label":"G — Glucose / goals of care review","hint":"Daily goals and escalation plan reviewed"}
]'::jsonb),
('respiratory_admission', 'Respiratory admission checklist', 'Admission workup for a patient admitted with respiratory failure or suspected pneumonia.', 'Respiratory', true, '[
  {"key":"viral_swabs","label":"Viral swabs sent","hint":"Respiratory viral PCR panel"},
  {"key":"sputum","label":"Sputum sample sent","hint":"Culture and sensitivity"},
  {"key":"cxr","label":"Chest X-ray performed and reviewed","hint":null},
  {"key":"ctpa","label":"Consider CTPA","hint":"If pulmonary embolism suspected"},
  {"key":"urinary_antigens","label":"Urinary antigens sent","hint":"Pneumococcal and Legionella antigens"},
  {"key":"bal","label":"If intubated, consider BAL","hint":"Bronchoalveolar lavage for microbiology"},
  {"key":"steroids","label":"Does the patient fulfil criteria for steroids?","hint":"E.g. COPD exacerbation, severe CAP, asthma"},
  {"key":"abg","label":"Arterial blood gas reviewed","hint":null},
  {"key":"micro_plan","label":"Antimicrobial plan documented","hint":"Agent, indication, review date"}
]'::jsonb);