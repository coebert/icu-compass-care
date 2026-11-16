# Security remediation: deployment sequencing

> **Release gate:** every production change in this document (publishing,
> applying SQL, changing secrets/config or the cron job, running cleanup,
> enabling CCC features) waits for the explicit coordinated-release approval.
> **That approval has NOT been granted.** Nothing below is an instruction to
> run now.

## Current state (16/11/2026, 20:15 UTC; read-only evidence)

| Item | State | Evidence |
| --- | --- | --- |
| drizzle `0002`, `0003`, `0004` | APPLIED to live (0001 is comment-only) | live function/trigger metadata |
| Staged `0005`–`0010` | NOT applied; tested only on PGlite and throwaway PostgreSQL | required functions absent from live `pg_proc` |
| `docs/security/postpublish-cleanup.sql` | NOT applied (`enforce_session_baseline = false`) | live settings metadata |
| Hub **server** code | **Updated code is live** (published_at 16/11/2026 19:23:35 UTC) | publish settings; bridge feeds run the `bridgeExport` code (503 without 0008); `inbound_sync` events; logs tagged published |
| Hub **frontend assets** served to browsers | **Not verified** | no check of the served bundle was made |
| Partner-URL guard (`src/lib/partner-url.ts`) | NOT live: committed after 19:23 (19:59 UTC onward) | commit timestamps |
| `PARTNER_BRIDGE_URL` | Misconfigured: points at this Hub (`icu-compass-care.lovable.app`), not CCC | health-shape comparison, see "Live incident" |
| Critical Care Connect (CCC) | Serves sync v1 to a signed read; its release is owned by the CCC team | one signed GET, see "Live incident" |

So the release is neither "all unreleased" nor "fully released": updated Hub
server code runs against a database that lacks 0005–0010. Exactly which source
commit the 19:23 publish contains, and when the behaviour change seen at about
18:27 was deployed, are not established.

Live effect of the missing SQL (observed or expected from the live code):
bed moves/swaps answer "not available" (never two separate writes); inbound
imports write nothing; CCC reads of investigations, microbiology, referrals,
notifications and audit answer 503 "Service unavailable" (never an unscoped or
empty list); the wardable endpoint answers 503; "Confirm prefill" answers
"isn't available right now" and writes nothing; the Sync review page shows
referrals as "can't be compared yet" (never "in sync"); the existing partner
investigation insert keeps its current shared-only rule. The bed board feed
(`/bridge/beds`) answers 200.

## Older clients against 0002–0004 (compatibility notes)

These apply to any browser tab still running a client built before the
security remediation. Whether the published frontend assets are still such a
client is not verified (see above), so treat these as possible until it is.

- **No clinician lockout:** the idle baseline for sessions with no activity record is built but switched OFF (`private.security_settings.enforce_session_baseline = false`). Older-client sessions stay usable.
- **Handover history:** an older client shows clinicians an empty history list. Legacy combined snapshots are Trust-admin only.
- **Passkeys:**
  - Unlock still works on an older client.
  - Enrolment on an older client needs a sign-in within the last 10 minutes.
- **Staff admin:**
  - Older server code changes roles through server-side database access. These changes still work and are audited automatically by a trigger.
  - Older-client unit access grants need a sign-in within the last 10 minutes plus a reason.
  - **Older-client unit-access REMOVAL is refused.** Direct deletes were revoked and an older client has no audited path; the current client uses `admin_set_unit_access`.
- **Role change RPC:** the reason-less RPC is no longer executable by clients. No current code calls it.

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

## Coordinated Hub / CCC release — staged, NOT applied

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

0005–0010 add functions, private ledgers and one index; they change no
existing table grants, so a browser tab running an older Hub client keeps
working after they are applied.

### Legacy referrals: never adopted automatically

Existing local referral copies have no import provenance. After 0006 the
first import of each reports a conflict for review; it is never adopted,
overwritten, deleted or merged automatically, even when its content equals
CCC's. The Sync review page (Trust administrators only) lists such rows as
"Needs review" with no Pull button. Resolving them is a separate, reviewed
step outside this release and needs its own approval.

### Live incident 16/11/2026: inbound pulls fail with `partner_http_error`

Read-only evidence (status codes, schema keys, timestamps and aggregate
counts only; no clinical rows read):

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
- Timeline from `bridge_sync_events`: current-code (`inbound_sync`) pulls began
  16:25 with `contract_mismatch` (self returned the legacy `{records}` shape);
  from 18:30 they get 503 (self now runs the `bridgeExport` code).
- Legacy events (actor role `admin`, about one per 70 s) are recorded as
  successful until 18:20/18:25 and then stop. These events can represent
  partner reads as well as writes, so their counts do **not** establish how
  many records, if any, were written. A metadata-only query of
  `public.record_audit` since 15/11/2026 19:00 UTC for `diff->>'source' =
  'bridge'` on the patient and investigation entity types returned zero rows;
  that absence does not prove there was no earlier effect. **Any effect of the
  legacy events on clinical records is unestablished; no clinical-record
  review has been performed.** What triggered the legacy events is unknown.
- Same signed GET straight to CCC with the same secret and actor: HTTP 200,
  `schema_version:1`, `snapshot_at` ISO, `pagination{next_cursor,complete}`.
  An in-memory dry run of the Hub validators (no writes) accepted complete
  snapshots for all three feeds (referrals 4 rows incl. 3 minimal tombstones,
  0 malformed; investigations 0; microbiology 0).
- Live functions present: 0002–0004 helpers. Missing: `move_patient_beds`,
  `bridge_import_referral`, `bridge_import_result`, `bridge_set_wardable`,
  `bridge_export_*` (5), `apply_referral_prefill`, `bridge_referral_review`.

Source fix (committed, not live): `src/lib/partner-url.ts` rejects a partner
base that is this app or not a bare https origin; the client sends no signed
request and records `partner_url_invalid`. Referral links, CORS and the admin
health check use the same check.

## Authoritative release order (each step needs the release approval)

This is the only release order; it supersedes earlier plans. The rule is
receiver before producer: CCC must read the new Hub responses before Hub
serves them to it.

0. **Decision (approval holder):** keep the 19:23 publish live until the
   steps below, or re-publish an earlier version. The live server already runs
   updated code; the missing SQL makes the new paths fail closed (see
   "Current state").
1. **Compatible CCC build.** Confirm the CCC build that accepts both the
   current and the new Hub responses is live: bed payload with `unit_code`,
   scoped `GET /bridge/patients?id=` empty envelope and opaque 404, required
   `expected_updated_at` on patient POST, generic 503 bodies, and the
   `/bridge/patients/wardable` 200/409 shapes; plus its opt-in sync v1 feeds
   (`?sync=1`, explicit `deleted_at: null`, minimal tombstones) with legacy
   feeds unchanged. CCC does not yet call the wardable endpoint.
2. **Hub database 0005–0010.** Apply 0005 → 0006 → 0007 → 0008 → 0009 → 0010
   in that order. Each runs its own preflight and aborts without changes on
   doubt (for example duplicate active beds or a missing SDH-RADNOR unit);
   never clean up data to make a preflight pass. Then run the verification
   queries below.
3. **Publish the latest reviewed Hub source** (includes the partner-URL guard),
   and record the commit published. Then confirm the frontend assets browsers
   receive are that build.
4. **Correct `PARTNER_BRIDGE_URL`** in Project Settings → Secrets to the bare
   origin `https://critical-care-flow.lovable.app` (no path, query or
   trailing data). Do not change the signing secret. Do not change the
   existing published cron (`bridge-sync-every-5-min`, `*/5`, hook path
   `/api/public/hooks/bridge-sync`); it already reaches the published
   deployment. The new value is used on the next cron pass.
5. **CCC activation** (including CCC use of the wardable endpoint) follows
   CCC's own staged activation sequence under CCC's runbook, not this one.
6. **Verify scheduled results.** Check that the next scheduled passes record
   current `inbound_sync` events per resource (referrals, investigations,
   microbiology) with success or reviewable conflicts in Sync status. Do not
   trigger a manual sync to do this. Legacy referrals appear as conflicts for
   review (see above), never adopted.
7. **Deferred cleanup — separately reviewed, not part of this run.** No sooner
   than about 1 hour (the access-token lifetime) after step 3, so older tabs
   and tokens have refreshed onto the new client, review and then, with its own
   approval, run `docs/security/postpublish-cleanup.sql` (authoritative). It
   switches on the idle baseline for sessions with no activity record
   (sessions over 15 minutes without a heartbeat lock; passkey users unlock,
   others sign in again) and removes the transitional client write paths for
   WebAuthn challenges/credentials and unit-access grants, keeping the read
   and server grants. Rollback for the baseline: set
   `private.security_settings.enforce_session_baseline` back to `false`.
   Run its verification queries afterwards.
8. **Separate review (outside this release):** whether the legacy events
   changed any clinical record is unestablished (see "Live incident"). Any
   review needs its own authorisation for clinical-record access.

Do not reverse steps 1 and 3: serving the new Hub responses to a CCC build
that cannot read them would break CCC.

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
