-- Run ONCE, only AFTER the reviewed frontend is published and old tabs have
-- refreshed (~1 hour). Not in drizzle/migrations, so it is never auto-applied.
-- Policy names checked against the live schema on 30/10/2026.

-- 1) Idle baseline for sessions with no activity record (rollback: set false).
UPDATE private.security_settings SET enforce_session_baseline = true, updated_at = now();

-- 2) WebAuthn challenges: server-only writes. Users keep SELECT of their own rows.
DROP POLICY IF EXISTS "Active sessions write own challenges (legacy client)" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "Active sessions update own challenges (legacy client)" ON public.webauthn_challenges;
DROP POLICY IF EXISTS "Users clear own challenges" ON public.webauthn_challenges;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.webauthn_challenges FROM anon, authenticated;

-- 3) WebAuthn credentials: no direct enrolment (server-only). Rename/remove kept.
DROP POLICY IF EXISTS "Reauthenticated active sessions enrol own passkeys" ON public.webauthn_credentials;
REVOKE INSERT ON public.webauthn_credentials FROM anon, authenticated;

-- 4) Unit membership: only via public.admin_set_unit_access. Read policy kept.
DROP POLICY IF EXISTS "Transitional: reauthenticated admins grant unit access" ON public.user_unit_access;
REVOKE INSERT ON public.user_unit_access FROM anon, authenticated;

-- Preserve server and read access.
GRANT ALL ON public.webauthn_challenges, public.webauthn_credentials, public.user_unit_access TO service_role;
GRANT SELECT ON public.webauthn_challenges, public.webauthn_credentials, public.user_unit_access TO authenticated;

-- Verification (expect: true; then all false; then only SELECT/DELETE/UPDATE policies listed).
SELECT enforce_session_baseline FROM private.security_settings;
SELECT t, p, has_table_privilege(r, t, p) AS granted
FROM unnest(array['anon','authenticated']) r,
     (VALUES ('public.webauthn_challenges','INSERT'),('public.webauthn_challenges','UPDATE'),
             ('public.webauthn_challenges','DELETE'),('public.webauthn_challenges','TRUNCATE'),
             ('public.webauthn_credentials','INSERT'),('public.user_unit_access','INSERT')) v(t, p);
SELECT has_table_privilege('authenticated','public.user_unit_access','SELECT') AS read_kept,
       has_function_privilege('authenticated','public.admin_set_unit_access(uuid,uuid,boolean,text)','EXECUTE') AS rpc_kept;
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname='public' AND tablename IN ('webauthn_challenges','webauthn_credentials','user_unit_access')
ORDER BY 1, 2;
