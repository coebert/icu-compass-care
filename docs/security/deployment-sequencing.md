# Security remediation: deployment sequencing

Applied live: 0002, 0003, 0004 (0001 is comment-only). The published frontend is still the OLD build.

## Old frontend + new database (current state)
- **No clinician lockout:** the idle baseline for sessions with no activity record is built but switched OFF (`private.security_settings.enforce_session_baseline = false`). Old-client sessions stay usable.
- **Handover history:** clinicians see an empty history list until the new client is published. Legacy combined snapshots are Trust-admin only.
- **Passkeys:**
  - Unlock still works on the old client.
  - Enrolment on the old client needs a sign-in within the last 10 minutes.
- **Staff admin:**
  - The old server code changes roles through server-side database access. These changes still work and are now audited automatically by a trigger.
  - Old-client unit access grants need a sign-in within the last 10 minutes plus a reason.
  - **Old-client unit-access REMOVAL is refused until publish.** Direct deletes were revoked and the old client has no audited path. Trust admins can wait, or publish.
- **Role change RPC:** the reason-less RPC is no longer executable by clients. No published code calls it.

## Publish steps (in order)
1. Publish the reviewed frontend.
2. Wait for old tabs to refresh (about 1 hour, the token lifetime).
3. Apply the follow-up SQL below as one migration. NOT applied yet.

```sql
-- a) Enforce the idle baseline for sessions with no activity record.
--    Sessions older than 15 minutes without a heartbeat become locked: passkey
--    users can unlock; others sign in again.
UPDATE private.security_settings SET enforce_session_baseline = true, updated_at = now();
-- b) Remove transitional direct credential / membership write paths.
DROP POLICY "Active sessions write own challenges (legacy client)" ON public.webauthn_challenges;
DROP POLICY "Active sessions update own challenges (legacy client)" ON public.webauthn_challenges;
REVOKE INSERT, UPDATE ON public.webauthn_challenges FROM authenticated;
DROP POLICY "Reauthenticated active sessions enrol own passkeys" ON public.webauthn_credentials;
REVOKE INSERT ON public.webauthn_credentials FROM authenticated;
DROP POLICY "Transitional: reauthenticated admins grant unit access" ON public.user_unit_access;
REVOKE INSERT ON public.user_unit_access FROM authenticated;
```
Statement a) is a data change on a one-row settings table; it can also be run as a single query. Rollback for a): set the flag back to `false`.

## Known limitations
- **Locked tokens:** access tokens stay cryptographically valid until they expire (about 1 hour). A lock is enforced by row-level security and server checks (`session_active()`), not by revoking the token.
- **Reauthentication evidence:** this is the signed token's `amr` timestamp. A password confirmation creates a new auth session.
- **Anti-framing (CSP):**
  - `frame-ancestors` allows only `'self'`, `https://lovable.dev` and `https://www.lovable.dev`. If the Lovable editor ever embeds from another origin, the preview will refuse to display until that exact origin is added.
  - No `script-src`/`style-src` restriction is set, because the framework uses inline bootstrap scripts. CSP therefore does not mitigate XSS here.
  - The headers are applied by app middleware. Assets served directly by the hosting edge may not carry them.
- **Concurrency:** tested with two real connections on a throwaway local PostgreSQL 17 (`tests/security/concurrency/run.sh`), not on the live database.
