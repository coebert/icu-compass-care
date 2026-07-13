-- 1. antimicrobial_library: replace always-true write policies with a clinical-access role check
DROP POLICY IF EXISTS "Staff can add antimicrobial names" ON public.antimicrobial_library;
DROP POLICY IF EXISTS "Staff can edit antimicrobial names" ON public.antimicrobial_library;
DROP POLICY IF EXISTS "Staff can remove antimicrobial names" ON public.antimicrobial_library;

CREATE POLICY "Clinical staff can add antimicrobial names"
  ON public.antimicrobial_library FOR INSERT TO authenticated
  WITH CHECK (private.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical staff can edit antimicrobial names"
  ON public.antimicrobial_library FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical staff can remove antimicrobial names"
  ON public.antimicrobial_library FOR DELETE TO authenticated
  USING (private.has_clinical_access(auth.uid()));

-- 2. bridge_sync_events: make it explicit that authenticated clients cannot write.
-- This table is written only by backend/service-role code (which bypasses RLS).
CREATE POLICY "No client insert on sync events"
  ON public.bridge_sync_events FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "No client update on sync events"
  ON public.bridge_sync_events FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "No client delete on sync events"
  ON public.bridge_sync_events FOR DELETE TO authenticated
  USING (false);

-- 3. webauthn_credentials: prevent owning users from changing security-critical
-- columns (counter, public_key, credential_id, ...) via the client. Owners may
-- only update the non-sensitive device_label; system-managed columns are updated
-- by backend code using the service role.
REVOKE UPDATE ON public.webauthn_credentials FROM authenticated;
GRANT UPDATE (device_label) ON public.webauthn_credentials TO authenticated;