-- 1. Restrict handover_versions reads to clinical staff (was USING (true))
DROP POLICY IF EXISTS "Signed-in staff can read handover versions" ON public.handover_versions;
CREATE POLICY "Clinical staff can read handover versions"
  ON public.handover_versions
  FOR SELECT
  TO authenticated
  USING (private.has_clinical_access(auth.uid()));

-- 2. Ensure any authenticated INSERT into patient_field_changes enforces clinical access.
-- (Normal writes go through the service role, which bypasses RLS; this makes the
-- write path safe if ever performed via a user's RLS-enforced client.)
DROP POLICY IF EXISTS "Clinical staff can insert patient field changes" ON public.patient_field_changes;
CREATE POLICY "Clinical staff can insert patient field changes"
  ON public.patient_field_changes
  FOR INSERT
  TO authenticated
  WITH CHECK (private.has_clinical_access(auth.uid()));