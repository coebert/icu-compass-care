# Fail-closed RLS design

This document explains why several tables in the ICU Handover database
deliberately expose **fewer** RLS policies than a typical CRUD table. Security
scanners flag these as "missing INSERT/UPDATE/DELETE policy" — the omissions
are intentional and are the safer default.

## The principle

Postgres Row Level Security is **default-deny**. Once `ENABLE ROW LEVEL
SECURITY` is set, any operation without a matching `USING`/`WITH CHECK` policy
is refused. Therefore:

> **Not writing a policy is itself a security control.**
> Roles reached through the Data API (`anon`, `authenticated`) cannot perform
> the operation at all. Only the `service_role` — used exclusively by trusted
> server code inside `createServerFn` handlers and verified webhook routes —
> can act, because it bypasses RLS.

This is called **fail-closed**: the absence of a rule denies access, rather
than permitting it. It is the opposite of the common web-app default (allow
unless denied), and it is the correct posture for clinical data.

## Tables intentionally missing write policies

### `notification_deliveries` — no INSERT / UPDATE / DELETE

This table records outbound delivery attempts (email/push/etc.) for
notifications. Rows are written **only** by server code that has just
performed the delivery — never by the browser.

- **SELECT** policy exists so a clinician can see the delivery status of their
  own notifications in the UI.
- **INSERT/UPDATE/DELETE** intentionally omitted. Delivery writes come from
  server functions using `supabaseAdmin` (service_role, bypasses RLS). A
  client that tried to fabricate a "delivered" row would simply be denied by
  Postgres — no policy exists, so no path is open.
- Adding a client-side INSERT policy would let an attacker forge delivery
  receipts (e.g. mark a critical alert as "seen"), which is precisely the
  audit-integrity property we want to prevent.

### `patient_field_changes` — no UPDATE / DELETE

This is an **append-only audit log** of who changed which patient field, when,
and to what value. Its integrity underpins every retrospective review of a
clinical decision.

- **INSERT + SELECT** policies exist so clinicians can record and read
  history.
- **UPDATE/DELETE** intentionally omitted. Once written, a change record
  cannot be altered or removed through the Data API — not by the author, not
  by an admin, not by anyone signing in as `authenticated`.
- If a genuine correction is ever needed, it is added as a **new** row
  describing the correction. The original stays. This mirrors how paper
  clinical notes work: you strike through and countersign, you never erase.
- The same pattern applies to `audit_log`, `record_audit`,
  `bridge_security_events` and `bridge_sync_events` — all append-only.

## Why "fewer policies" is more secure here

A common review reflex is "add a policy for every operation." For clinical
audit and delivery-tracking data that reflex is wrong:

| Approach | Result |
| --- | --- |
| Add `TO authenticated UPDATE` on `patient_field_changes` | Any signed-in staff member could silently rewrite history. RLS "correct" but audit trust destroyed. |
| Leave UPDATE unpoliced (current design) | Postgres refuses every client UPDATE. Only trusted server code with `service_role` can touch the row — and it doesn't, because it never needs to. |

The scanner sees an empty policy list and reports "no controlled write path".
That description is accurate but the implied risk is inverted: **the absence
of a write path is the control**.

## Rules for future tables

When adding a new table, ask two questions:

1. **Should the browser ever write this row directly?**
   If no, omit INSERT/UPDATE/DELETE policies. Do the write from a
   `createServerFn` handler using `supabaseAdmin` after authorising the
   caller (`requireSupabaseAuth` + `has_role` check).

2. **Once written, may this row ever change?**
   If no (audit trails, delivery receipts, security events, immutable
   snapshots), omit UPDATE and DELETE policies even if INSERT is allowed.
   Corrections become new rows.

If the answer to both is "yes, from the client", write full CRUD policies
scoped to `auth.uid()` (or `has_clinical_access(auth.uid())` for shared
clinical data) — that is the standard path for editable, user-owned data.

## Related enforcement

- `patients_guard_share_flag` trigger — server-side check that only admins can
  flip `shared_with_partner`, complementing (not replacing) the RLS policy.
- `postop_bookings_validate_lifecycle` trigger — enforces required fields
  regardless of which client attempts the write.
- Role checks live in the `private` schema (`private.has_role`,
  `private.has_clinical_access`) so they cannot be called from the Data API
  and are only reachable inside policies and security-definer functions.

Together these give a defence-in-depth model: RLS blocks the wrong role,
triggers block the wrong shape, and the absence of policies blocks whole
categories of write entirely.
