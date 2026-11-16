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
3. Run `docs/security/postpublish-cleanup.sql` (authoritative, supersedes the sketch below). NOT applied yet.

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

## Round 4 (30/10/2026)
- Live state: 0002, 0003, 0004 applied; `enforce_session_baseline = false`; old reason-less role RPC not executable by users; direct role writes and unit-access deletes revoked; 4 role/membership guard triggers present.
- Password resets are Trust-admin-only (server check + recent reauth). Unit admins see a prompt to ask a Trust admin. Code-only change, no database change.
- A new auth session (password reauth) resets lock state, the inactivity deadline and cached data in the client. Code-only change.

## Coordinated Hub / CCC release (Nov 2026) — staged, NOT applied

Staged SQL (apply in this order, only when the coordinated release gate is
given; each aborts without changes if its preflight fails):

1. `docs/security/staged-migrations/0005_bed_integrity.sql` — UTF-8 + duplicate
   active-bed preflight, normalised one-active-patient-per-bed index,
   `move_patient_beds` (move / swap / undo; revision-checked; audit rows
   written inside the same transaction).
2. `docs/security/staged-migrations/0006_bridge_import_provenance.sql` —
   SDH-RADNOR preflight, `private.bridge_unit_id()`, protected referral
   provenance ledger, `bridge_import_referral(jsonb)`,
   `bridge_import_result(text,jsonb)`, and `bridge_insert_investigation`
   restricted to shared patients in the bridge unit.
3. `docs/security/staged-migrations/0007_bridge_wardable_fence.sql` — wardable
   fence ledger and `bridge_set_wardable` (service role only).
4. `docs/security/staged-migrations/0008_bridge_read_exports.sql` — partner
   clinical read exports (`bridge_export_investigations`, `_microbiology`,
   `_referrals`, `_notifications`, `_audit`). Each checks "bridge-unit patient,
   still shared" in the same statement that reads the rows; audit entries are
   typed (`patients` / `referrals`). Service role only; adds functions only.

Behaviour before they are applied (if the frontend were published first):
bed moves are refused ("not available yet") rather than done as two writes;
scheduled imports report `import_unavailable` and write nothing; the wardable
endpoint answers 503; the existing partner investigation insert keeps its
current (shared-only) rule; the partner clinical READ feeds (investigations,
microbiology, referrals, notifications, audit) answer 503 "Service
unavailable" — never an unscoped or empty list — until 0008 exists.
Recommended order: apply 0005–0008, verify with the queries below, then
publish the frontend, then enable the CCC side.

Verification (metadata only):

```sql
SELECT indexname FROM pg_indexes WHERE indexname = 'patients_active_unit_bed_uniq';
SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p
 WHERE p.proname IN ('move_patient_beds','bridge_import_referral','bridge_import_result',
                     'bridge_insert_investigation','bridge_set_wardable','bridge_unit_id');
SELECT has_function_privilege('authenticated','public.bridge_set_wardable(uuid,timestamptz,boolean,text,jsonb)','EXECUTE') AS must_be_false,
       has_function_privilege('service_role','public.bridge_set_wardable(uuid,timestamptz,boolean,text,jsonb)','EXECUTE') AS must_be_true,
       has_function_privilege('authenticated','public.bridge_insert_investigation(uuid,text,text,timestamptz)','EXECUTE') AS must_be_false_2;
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS must_be_false,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS must_be_false_2,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS must_be_true
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'bridge_export_%';
SELECT has_table_privilege('authenticated','private.bridge_referral_provenance','SELECT') AS must_be_false,
       has_table_privilege('authenticated','private.bridge_wardable_fence','SELECT') AS must_be_false_2;
```

Existing local referral copies have no import provenance, so after 0006 the
first import of each reports a conflict for review (never adopted). That is
intended; resolving them is a reviewed, separate step.
