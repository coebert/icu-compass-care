# Fenced "ready for ward" (wardable) protocol

Status: implemented in ICU Handover Hub, **database helper staged, not applied**
(`docs/security/staged-migrations/0007_bridge_wardable_fence.sql`, needs 0006).
Until 0007 is applied the endpoint answers `503 {ok:false, code:"unavailable"}`.

## Endpoint

`POST /api/public/bridge/patients/wardable` — HMAC-signed like every other
bridge write (`x-timestamp`, `x-actor`, `x-signature`), body ≤ 2 KB, one-time
signature (replay → `401 {ok:false, code:"replay"}`). Actor roles: `admin`,
`unit_admin`, `clinician`. The audit actor is taken from the verified signed
`x-actor` envelope only.

The generic `POST /api/public/bridge/patients` **refuses** any body containing
`wardable`, `wardable_at` or `wardable_by` (`400 wardable_not_accepted`).
Native Hub edits are unaffected.

### Request — exactly these four keys

```json
{ "id": "<uuid>", "expected_updated_at": "<ISO instant with zone>", "wardable": true, "desired_revision": "42" }
```

* `desired_revision`: canonical positive decimal **string**, `1..9223372036854775807`
  (no sign, no leading zeros, never sent or parsed as a JSON number).
  CCC allocates it from a durable, per-patient, strictly increasing,
  non-deletable counter. The Hub never invents or resets revisions.
* `expected_updated_at`: the patient `updated_at` CCC last fetched (exact).
* No `wardable_at` / `wardable_by`: the Hub stamps its own clock on an actual
  state change (`wardable_at = now()` when set true, `null` when cleared;
  `wardable_by = null` because the actor is a partner principal — it is in the
  audit row instead).

### Responses

| HTTP | Body |
|---|---|
| 200 | `{ok:true, status:"applied"\|"already_applied", desired_revision:"<string>", patient:{id, wardable, wardable_at, updated_at}}` |
| 409 | `{ok:false, code:"superseded"\|"revision_conflict"\|"intent_conflict"\|"target_changed", desired_revision:"<highest reserved, string>"}` |
| 404 | `{ok:false, code:"not_found"}` — missing, not shared, revoked, or not in SDH-RADNOR (identical; no fence detail) |
| 400 | `{ok:false, code:"invalid_request"}` |
| 401 | signature failure, or `{ok:false, code:"replay"}` |
| 503 | `{ok:false, code:"unavailable"}` |

Error bodies never contain a patient object.

### Fence rules (per patient, one transaction; patient row locked, then fence)

Let *H* = highest revision ever received (reserved), *A* = revision applied.

1. `desired < H` → **superseded**. Nothing changes.
2. `desired = H`, different `wardable` → **intent_conflict**.
3. `desired = H = A` → never rewritten: **already_applied** if the current
   `wardable` still equals that intent, else **target_changed**.
4. `desired = H`, pending (reserved, not applied), same intent → applies only
   if `expected_updated_at` equals the current version exactly.
5. `desired > H` → *H* := desired is **reserved and committed first**, then:
   * version mismatch → **revision_conflict** (reservation kept; returned, not raised);
   * version matches → apply: change state if different, write the audit row,
     mark *A* := desired. If the state already equals the intent, it is still
     marked applied so an older in-flight toggle can never reverse it.
6. Any failure while applying (including the audit insert) rolls back the whole
   call: no partial clinical state, and `503`.

### Client rules (CCC)

* Treat every 409 as conflict / human review. **Do not** automatically re-fetch
  the patient and resend with a new `expected_updated_at`.
* After an unknown transport outcome (timeout, 5xx, network), retry only the
  **same** `desired_revision` and the **same** `wardable` (new signature).
  Never silently rebase an old operation onto a fresh version.
* A deliberate new intent after review gets a **new, higher** revision.

Typed helpers: `src/lib/bridge-wardable.ts` (`parseWardableRequest`,
`wardableHttp`, `parseWardableResponse`).
