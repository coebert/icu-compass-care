<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Sensitive account/credential actions require server-checked recent reauth (JWT `amr`) plus an active session; the client wraps calls in `withReauth` (src/lib/reauth.ts). Why: a locked or stolen session must not change credentials.
- WebAuthn challenges/credentials are written only by server code via the service role, bound to user+session+purpose+expiry. Why: browser-written rows must never unlock a session.
- Security headers live in src/lib/security-headers.ts (CSP frame-ancestors allows only exact Lovable editor origins; no script-src). Why: prevent clickjacking without breaking preview or app boot.
- Role and unit-membership changes go only through `admin_replace_user_roles` / `admin_set_unit_access` (lock first, then session + reauth + reason + scope + suspension checks, audit in the same transaction). Why: TS-only checks could be bypassed via the Data API.
- Session state errors are "unknown" and fail closed (src/lib/session-lock.ts); a lock is only shown after server confirmation, otherwise sign out. Why: never claim protection that failed.
- Tests that touch the connected live backend are excluded unless ALLOW_LIVE_BACKEND_TESTS=1 (vitest.config.ts). Why: no staging copy exists.
- Untrusted input is size-checked before Zod (src/lib/input-bounds.ts): global function middleware for every server function, plus `readBodyLimited` + bounds on partner write routes. Why: Zod 3 has no fix for GHSA-mrhx-c7xc-m3w5 and `.max()` still validates every element.
- Partner bed board counts occupancy from minimal non-identifying facts for all active ICU rows; identity comes only from still-shared rows; any doubt returns a safe 503 (src/lib/bridge-beds.ts). Why: a withheld patient must never look like a free bed.
- Inbound sync logs one event per resource per pass, tagged actor_role `inbound_sync`, with safe codes only; status reads latest attempt and success per resource (src/lib/sync-status*.ts). Why: one healthy stream must not hide another's failure, and no PHI in logs.
- Writes based on a preview compare-and-set on the previewed `updated_at` (e.g. src/lib/referral-prefill.server.ts). Why: a concurrent edit must force reload and reconfirm.
- Hub owns patients; CCC data is imported only via sync v1 (src/lib/bridge-contract.ts validates every page first) through SECURITY DEFINER helpers that resolve the bridge unit themselves, keep referral provenance (source vs receiver revision) and audit in the same transaction. Why: an unvalidated or unowned row must never overwrite local clinical data.
- Partner "ready for ward" changes go only through the fenced `bridge_set_wardable` protocol (docs/bridge/wardable-protocol.md); revisions stay decimal strings end to end. Why: out-of-order partner intents must never reverse a newer one, and JS numbers lose precision past 2^53.
- Partner clinical read feeds go only through `bridgeExport` (src/lib/bridge-exports.server.ts) → staged `bridge_export_*` SQL that checks bridge unit + still-shared parent in the same statement; never fetch a list of shared ids then query again. Why: a separate id list is cross-unit and survives a revocation.
- Previous-admission matching uses only an exact normalised hospital number (src/lib/previous-admission.ts) and copies only labelled PMH into a blank field; historical TEP/DNACPR are display-only. Why: initials + age can't identify a patient and old decisions must not become current ones.
- Referral prefill only works for a patient already linked (`source_referral_id`) to that referral; the app never infers or creates the link. Why: age/ward/initials can't safely identify a patient.
- Schema changes not yet authorised for live are staged in docs/security/staged-migrations (applied in filename order) and tested only on PGlite / throwaway PostgreSQL. Why: there is no staging copy of the clinical database.
