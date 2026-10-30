DROP POLICY IF EXISTS "Staff can view checklist template history" ON public.checklist_template_versions;
CREATE POLICY "Staff can view checklist template history" ON public.checklist_template_versions FOR SELECT TO authenticated
USING (private.has_clinical_access(auth.uid()) OR private.is_config_admin(auth.uid()) OR private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Staff can view antimicrobial library" ON public.antimicrobial_library;
CREATE POLICY "Staff can view antimicrobial library" ON public.antimicrobial_library FOR SELECT TO authenticated
USING (private.has_clinical_access(auth.uid()) OR private.is_config_admin(auth.uid()) OR private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Authenticated can view beds" ON public.icu_beds;
CREATE POLICY "Authenticated can view beds" ON public.icu_beds FOR SELECT TO authenticated
USING (private.has_clinical_access(auth.uid()) OR private.is_config_admin(auth.uid()) OR private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()));

DROP POLICY IF EXISTS "Staff can view checklist templates" ON public.checklist_templates;
CREATE POLICY "Staff can view checklist templates" ON public.checklist_templates FOR SELECT TO authenticated
USING (private.has_clinical_access(auth.uid()) OR private.is_config_admin(auth.uid()) OR private.is_trust_admin(auth.uid()));