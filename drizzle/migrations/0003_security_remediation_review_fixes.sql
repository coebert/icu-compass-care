-- Review fixes for security remediation (non-destructive; no rows or columns dropped).

-- Verified recent re-authentication, read from the signature-verified JWT `amr`.
CREATE OR REPLACE FUNCTION private.recent_reauth(_max_age_seconds integer DEFAULT 600)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END) e
    WHERE e ->> 'method' IN ('password','otp','totp','mfa/totp','webauthn','mfa/webauthn','magiclink')
      AND jsonb_typeof(e -> 'timestamp') = 'number'
      AND (e ->> 'timestamp')::numeric BETWEEN extract(epoch FROM now()) - _max_age_seconds
                                           AND extract(epoch FROM now()) + 60
  )
$$;

-- 1) Passkey challenges: bound to user + session + purpose + expiry; the
--    server issues and consumes them with the service role.
ALTER TABLE public.webauthn_challenges ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE public.webauthn_challenges ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes');
DROP POLICY IF EXISTS "Users manage their own challenges - all" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "Users read own challenges" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "Active sessions write own challenges (legacy client)" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "Active sessions update own challenges (legacy client)" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "Users clear own challenges" ON public.webauthn_challenges;
REVOKE ALL ON public.webauthn_challenges FROM anon;
CREATE POLICY "Users read own challenges" ON public.webauthn_challenges
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- Transitional: the currently published client still writes challenges
-- directly. Writes need an active (unlocked, non-idle) session and can never
-- claim a session binding, so the new server rejects them for unlock.
CREATE POLICY "Active sessions write own challenges (legacy client)" ON public.webauthn_challenges
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND session_id IS NULL AND private.session_active());
CREATE POLICY "Active sessions update own challenges (legacy client)" ON public.webauthn_challenges
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND private.session_active())
  WITH CHECK (auth.uid() = user_id AND session_id IS NULL AND private.session_active());
CREATE POLICY "Users clear own challenges" ON public.webauthn_challenges
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 1) Passkey credentials: enrolment needs an active session AND a recent
--    verified re-authentication; counters stay server-only.
DROP POLICY IF EXISTS "Users manage their own passkeys - insert" ON public.webauthn_credentials;
DROP POLICY IF EXISTS "Users manage their own passkeys - update" ON public.webauthn_credentials;
DROP POLICY IF EXISTS "Users manage their own passkeys - delete" ON public.webauthn_credentials;
DROP POLICY IF EXISTS "Reauthenticated active sessions enrol own passkeys" ON public.webauthn_credentials;
DROP POLICY IF EXISTS "Active sessions rename own passkeys" ON public.webauthn_credentials;
DROP POLICY IF EXISTS "Active sessions remove own passkeys" ON public.webauthn_credentials;
REVOKE ALL ON public.webauthn_credentials FROM anon;
REVOKE UPDATE ON public.webauthn_credentials FROM authenticated;
GRANT UPDATE (device_label) ON public.webauthn_credentials TO authenticated;
CREATE POLICY "Reauthenticated active sessions enrol own passkeys" ON public.webauthn_credentials
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND private.session_active() AND private.recent_reauth());
CREATE POLICY "Active sessions rename own passkeys" ON public.webauthn_credentials
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND private.session_active())
  WITH CHECK (auth.uid() = user_id AND private.session_active());
CREATE POLICY "Active sessions remove own passkeys" ON public.webauthn_credentials
  FOR DELETE TO authenticated USING (auth.uid() = user_id AND private.session_active());

-- 2) Raw audit_log (may hold clinical diffs): Trust admins, or the author
--    only while they still have active clinical access to that patient.
--    Auditors use the metadata-only public.audit_log_metadata().
DROP POLICY IF EXISTS "Trust admins and authors can read audit log" ON public.audit_log;
DROP POLICY IF EXISTS "Trust admins and in-scope authors can read audit log" ON public.audit_log;
CREATE POLICY "Trust admins and in-scope authors can read audit log"
  ON public.audit_log FOR SELECT TO authenticated
  USING (
    private.is_trust_admin(auth.uid())
    OR (user_id = auth.uid()
        AND entity = 'patients'
        AND entity_id IS NOT NULL
        AND private.can_access_patient(auth.uid(), entity_id))
  );
DROP POLICY IF EXISTS "Audit insertable by authenticated" ON public.audit_log;
DROP POLICY IF EXISTS "Active sessions append own audit entries" ON public.audit_log;
CREATE POLICY "Active sessions append own audit entries" ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND private.session_active());