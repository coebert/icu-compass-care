# App Review & Improvement Plan

An expert review of the ICU handover app covering security (highest priority — sensitive patient-identifiable clinical data), code quality, and elegance. Findings are backed by the security scanner, the database linter, direct RLS inspection, and a full code read.

## What's already good

- Server functions consistently gate on `requireSupabaseAuth`; admin ops verify the caller's role.
- The cross-project bridge uses timing-safe HMAC verification, timestamp skew limits, a signed actor envelope, RBAC, and a secret-rotation window.
- Patient input is validated with tight Zod schemas; most DB errors route through `safeDbError`.
- `setup`/`claimFirstAdmin` bootstrap paths are correctly self-disabling.

---

## Priority 1 — Security

### 1.1 Inconsistent RLS on three clinical tables (highest risk)
`patient_events`, `patient_reviews`, and `patient_tasks` use `USING (true)` / `WITH CHECK (true)` for all operations. Every comparable clinical table (`patients`, `investigations`, `referrals`) requires `private.has_clinical_access(auth.uid())`. Result: any authenticated account — even one with no clinical role — can read and modify patient event history, specialty review notes, and task lists. This is the source of the 3 scanner findings and most of the 9 linter warnings.

**Fix:** a migration that drops the 12 permissive policies and recreates them scoped to `private.has_clinical_access(auth.uid())`, exactly matching the `patients` table pattern (SELECT/INSERT/UPDATE/DELETE). Verify afterwards with the linter and by re-reading `pg_policies`.

### 1.2 Raw database errors leaked to clients
Five handlers throw `error.message` from Postgres directly instead of using `safeDbError` (which logs server-side and returns a generic message): `me.functions.ts` (updateMyProfile), `passkeys.functions.ts` (two sites), `sync.functions.ts`, and `reconcile.server.ts` (two sites). These can expose column/constraint names.

**Fix:** route all five through `safeDbError(error, "<action>")`.

### 1.3 Duplicated admin role-check
`assertAdmin` is copy-pasted verbatim in four files (`admin`, `beds`, `bridge-health`, `reconcile` functions). A future change to role logic risks reopening a privilege-escalation gap if a copy is missed.

**Fix:** extract one shared `assertAdmin(context)` (e.g. `src/lib/roles.server.ts`) and import it everywhere.

### 1.4 Bridge data-integrity / PII scope (governance flags)
- `bridge.patients.ts` selects `*`, exporting full PII (NOK contact, DNACPR/TEP details) to any caller holding the shared secret. Confirm this is an accepted, documented data-sharing agreement; if not, project to a safe column allow-list.
- The bridge `POST` handler bypasses the app's status-transition validator (`validatePatientState`), so a partner can push a patient to "died"/"discharged" without `date_of_death`/`discharge_destination`. Share and apply the same validator on the bridge write path.

These are decisions to confirm with you before changing behaviour.

---

## Priority 2 — Code quality

### 2.1 Shared patient schema & helpers between app and bridge
The ~50-field patient Zod schema exists twice (`patients.functions.ts` and `bridge.patients.ts`) and has already drifted — structured fields (`antimicrobials`, `vasoactive_agents`, `airway_type`, etc.) exist in the app but not the bridge, so they can never sync. Also duplicated: `clean()`/`cleanEmpty` and status-transition logic.

**Fix:** extract a single shared schema + helpers module imported by both paths, closing the sync gap.

### 2.2 Duplicated antimicrobial/course logic
`courseDays` and antimicrobial summarisation exist in both `handover-pdf.ts` and `patients.$patientId.tsx`.

**Fix:** move to one shared module (e.g. `src/lib/antimicrobials.ts`) and import in both.

### 2.3 Stronger types
`Record<string, any>` is used pervasively for patient/investigation data. Adopt the generated Supabase `Database` row types so field typos are caught at compile time.

---

## Priority 3 — Elegance / maintainability

### 3.1 Refactor `patients.$patientId.tsx` (2249 lines)
Ten near-identical systems-status widgets repeat the same mutation/toggle boilerplate. Extract a generic `useSystemFieldMutation` hook and a declarative field config (mirroring the clean `HANDOVER_COLUMNS` pattern), then split widgets into their own files.

### 3.2 Split `handover-pdf.ts` (641 lines)
Separate the three concerns into modules: column renderers, data-selection/sorting, and jsPDF layout — improving testability.

### 3.3 `getAdmin()` helper
Replace the ~12 repeated inline `await import(".../client.server")` lines with one small lazy helper that preserves the client-bundle exclusion.

---

## Suggested execution order

1. **Migration** for 1.1 (RLS) — biggest risk, self-contained; verify with linter.
2. **1.2 + 1.3** — small, safe server-function edits; add/confirm tests.
3. **Confirm 1.4 decisions** with you, then implement agreed bridge changes.
4. **2.1 + 2.2** — shared modules; run the existing test suite.
5. **2.3** typing pass.
6. **3.1 / 3.2 / 3.3** incremental refactors, each behind existing tests, no behaviour change.

Priorities 1–2 are behaviour-preserving except the intended RLS tightening and bridge validation; Priority 3 is pure refactor. I can start with the Priority 1 migration on approval.
