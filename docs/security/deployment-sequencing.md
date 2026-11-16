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

Status at 16/11/2026 (read from repository and live metadata only):

| Item | State |
| --- | --- |
| drizzle `0002`, `0003`, `0004` security remediation | APPLIED to live |
| `docs/security/postpublish-cleanup.sql` | STAGED, not applied |
| `docs/security/staged-migrations/0005`–`0010` (below) | STAGED, not applied; tested only on PGlite and throwaway PostgreSQL |
| Hub frontend/server changes | **LIVE on the published server** (published_at 16/11/2026 19:23:35 UTC; see "Live incident" below). The staged SQL is not. |
| Critical Care Connect (CCC) receiver changes | owned by the CCC team; must be live before the Hub publish (step 1) |

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
5. `docs/security/staged-migrations/0009_referral_prefill_atomic.sql` —
   `apply_referral_prefill(uuid,uuid,jsonb)`: the only write path for "fill
   blanks from linked referral". Session, role, unit, exact link, both
   previewed revisions, live referral and still-blank targets are checked
   under locks (referral, then patient) in the same transaction as the write,
   `record_audit` and `patient_field_changes`. Service role only; adds a
   function only.
6. `docs/security/staged-migrations/0010_bridge_referral_review.sql` —
   `bridge_referral_review(integer)`: read-only helper for the Trust-admin
   Sync review page. One statement returns every referral id known here
   (local rows and import-ledger entries, including watermarks) with the
   allowlisted comparable fields and whether the ledger still trusts the
   local copy, as a single jsonb value (not shortened by a REST row cap);
   above the limit it returns `complete:false` and no rows. Never returns
   receiver revisions. Service role only; adds a function only; writes nothing.

0006 also keeps a minimal tombstone watermark (id, source revision, source
deleted_at; no clinical content) for a referral deleted in CCC before Hub
ever imported it, so a delayed older/equal live copy can never resurrect it.

Behaviour before they are applied (if the frontend were published first):
bed moves are refused ("not available yet") rather than done as two writes;
scheduled imports report `import_unavailable` and write nothing; the wardable
endpoint answers 503; the existing partner investigation insert keeps its
current (shared-only) rule; the partner clinical READ feeds (investigations,
microbiology, referrals, notifications, audit) answer 503 "Service
unavailable" — never an unscoped or empty list — until 0008 exists; and
"Confirm prefill" answers "isn't available right now" and writes nothing
until 0009 exists; the Sync review page shows referrals as "can't be compared
yet" (never "in sync") until 0010 exists. The currently published (old) Hub
frontend keeps working after 0005–0010 are applied: they add functions, a private ledger and one
index, and change no existing table grants.

### Live incident 16/11/2026: inbound pulls fail with `partner_http_error`

Read-only evidence (status codes, schema keys and aggregate counts only):

- `PARTNER_BRIDGE_URL` host is `icu-compass-care.lovable.app` (path `/`) —
  this Hub's own published address, not CCC (`critical-care-flow.lovable.app`).
  The health shape at that host is the Hub's (`handover_api_secret_configured`,
  `partner_bridge_url_configured`, 97 patient keys); CCC's differs
  (`secret_configured`, `previous_secret_configured`, `partner_url_configured`).
- The `bridge-sync-every-5-min` cron calls
  `https://project--58df96bd-….lovable.app/api/public/hooks/bridge-sync`; that
  host serves the same published deployment (identical responses, logs tagged
  published). Its pull then calls the Hub's own
  `/api/public/bridge/{referrals,investigations,microbiology}?sync=1&limit=500`,
  which answer 503 `{"error":"Service unavailable"}` because `bridge_export_*`
  (0008) is not applied. Hub logs: `partner GET failed <path> 503` every 5 min.
- Timeline from `bridge_sync_events`: new-code (`inbound_sync`) pulls began
  16:25 with `contract_mismatch` (self returned the legacy `{records}` shape);
  from 18:30 they get 503 (self now runs the `bridgeExport` code). Older-code
  pulls (actor role `admin`, ~1 per 70 s, re-applying ~13.8k patient and ~2.9k
  investigation upserts per day from the self-feed) stopped at 18:20/18:25.
- Same signed GET straight to CCC with the same secret and actor: HTTP 200,
  `schema_version:1`, `snapshot_at` ISO, `pagination{next_cursor,complete}`.
  An in-memory dry run of the Hub validators (no writes) accepted complete
  snapshots for all three feeds (referrals 4 rows incl. 3 minimal tombstones,
  0 malformed; investigations 0; microbiology 0).
- Live functions present: 0002–0004 helpers. Missing: `move_patient_beds`,
  `bridge_import_referral`, `bridge_import_result`, `bridge_set_wardable`,
  `bridge_export_*` (5), `apply_referral_prefill`, `bridge_referral_review`.
  So on the live server today: native bed move/swap answers "not available",
  CCC reads of investigations/microbiology/referrals/notifications/audit get
  503, wardable POST 503, prefill confirm unavailable, Sync review "can't be
  compared". Bed board (`/bridge/beds`) answers 200.

Source fix (this build): `src/lib/partner-url.ts` rejects a partner base that
is this app or not a bare https origin; the client sends no signed request and
records `partner_url_invalid`. Referral links and CORS use the same check.

### Corrected release/config plan (each step needs release approval)

0. Decide whether to keep the 19:23 publish live or re-publish the previous
   version until the SQL gate; the live server already runs the prepared code.
1. Confirm the CCC build serving sync v1 (verified above) is the one intended.
2. Apply 0005 → 0006 → 0007 → 0008 → 0009 → 0010 (preflights abort on doubt),
   then run the verification queries below.
3. Publish this build (adds the URL guard).
4. Change the `PARTNER_BRIDGE_URL` secret to `https://critical-care-flow.lovable.app`
   (bare origin). Takes effect on the next cron pass without a publish; if done
   before step 2, pulls fail safely with `import_unavailable`.
5. Leave the cron as is (`*/5`, hook path `/api/public/hooks/bridge-sync`; it
   already reaches the published deployment). Check the next pass shows
   per-resource success or reviewable conflicts in Sync status.
6. Enable CCC wardable use, then run `postpublish-cleanup.sql`.
7. Review separately (metadata first) whether the earlier self-feed re-upserts
   changed any patient row; not assessed here (needs clinical-record access).

### Release order (paired; receiver before producer)

1. **CCC first (receiver of the Hub contract changes).** Deploy the CCC build
   that accepts both the current and the new Hub responses: bed payload with
   `unit_code`, scoped `GET /bridge/patients?id=` empty envelope and opaque
   404, required `expected_updated_at` on patient POST, generic 503 bodies,
   and the `/bridge/patients/wardable` 200/409 shapes. Its opt-in sync v1
   feeds (`?sync=1`, explicit `deleted_at: null`, minimal tombstones) must be
   live too; legacy feeds stay unchanged. CCC must not yet call the wardable
   endpoint.
2. **Hub database.** Apply 0005 → 0006 → 0007 → 0008 → 0009 → 0010 in that order,
   then run the verification queries below.
3. **Hub publish (producer).** Publish the Hub frontend/server.
4. **Enable CCC use** of the wardable endpoint and confirm the first sync
   pass reports per-resource success or reviewable conflicts.
5. **Post-publish cleanup.** Run `docs/security/postpublish-cleanup.sql`.

Do not reverse steps 1 and 3: a Hub publish before a compatible CCC receiver
would send CCC response shapes it cannot read.

Verification (metadata only):

```sql
SELECT indexname FROM pg_indexes WHERE indexname = 'patients_active_unit_bed_uniq';
SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p
 WHERE p.proname IN ('move_patient_beds','bridge_import_referral','bridge_import_result',
                     'bridge_insert_investigation','bridge_set_wardable','bridge_unit_id',
                     'apply_referral_prefill','bridge_referral_review');
SELECT has_function_privilege('authenticated','public.bridge_referral_review(integer)','EXECUTE') AS must_be_false,
       has_function_privilege('anon','public.bridge_referral_review(integer)','EXECUTE') AS must_be_false_2,
       has_function_privilege('service_role','public.bridge_referral_review(integer)','EXECUTE') AS must_be_true;
SELECT has_function_privilege('authenticated','public.apply_referral_prefill(uuid,uuid,jsonb)','EXECUTE') AS must_be_false,
       has_function_privilege('anon','public.apply_referral_prefill(uuid,uuid,jsonb)','EXECUTE') AS must_be_false_2,
       has_function_privilege('service_role','public.apply_referral_prefill(uuid,uuid,jsonb)','EXECUTE') AS must_be_true;
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
intended; resolving them is a reviewed, separate step. The Sync review page
(Trust administrators only) lists them as "Needs review" with no Pull button,
even when their content equals the partner's.
