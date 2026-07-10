# Partner Bridge — Integration Handoff

This document describes the cross-project data bridge exposed by the ICU
Handover app (Salisbury District Hospital Critical Care) so a linked partner
project can read and, where allowed, write clinical/occupancy data.

> **Clinical data.** Every payload here is PHI. Treat all requests, responses,
> logs, and secrets as confidential. Never cache responses at a shared/CDN
> layer, and never log request/response bodies.

---

## 1. How it works

The two apps run on **separate backends**, so this bridge cannot read the
partner app's user session. Instead:

1. The caller signs each request with a **shared HMAC secret**
   (`HANDOVER_API_SECRET`) — this proves the request came from the trusted
   partner app.
2. The caller forwards the acting user's identity/role in a **signed actor
   envelope** — this proves a real logged-in user is acting.
3. The bridge checks the actor's **role** — role-based access control.

All bridge endpoints live under `/api/public/*`, which bypasses the published
site's auth gate; security is enforced entirely by the HMAC signature check in
the handler.

---

## 2. Base URL

Use the **stable** project URL (immutable, unaffected by renames):

```
Production : https://project--58df96bd-2803-4146-90a7-4a08f526bece.lovable.app
Preview    : https://project--58df96bd-2803-4146-90a7-4a08f526bece-dev.lovable.app
```

---

## 3. Authentication (HMAC + signed actor)

### Headers on every authenticated request

| Header        | Value                                                        |
| ------------- | ----------------------------------------------------------- |
| `x-timestamp` | Unix time in **seconds** (must be within ±300s of server)   |
| `x-actor`     | JSON string `{ "id", "email", "role" }` of the acting user  |
| `x-signature` | hex `HMAC_SHA256(secret, message)` (see below)              |

### Signing algorithm

```
actor     = JSON.stringify({ id, email, role })      // exact bytes sent as x-actor
message   = `${timestamp}.${actor}.${rawBody}`       // rawBody is "" for GET
signature = hex( HMAC_SHA256(HANDOVER_API_SECRET, message) )
```

The signature is verified over the **exact bytes** of `x-timestamp`, `x-actor`,
and the raw request body — serialize the body once and sign/send that same
string.

### Roles

- Read endpoints accept roles: `admin`, `clinician`.
- Write endpoints accept roles: `admin`, `clinician`.
- Any other role → `403 Insufficient role for this action`.

### Secret rotation (zero-downtime)

The bridge accepts both `HANDOVER_API_SECRET` and, when set,
`HANDOVER_API_SECRET_PREVIOUS`. To rotate without an outage: set the new value
as current and the old value as previous on both projects, migrate signers to
the new secret, then remove the previous secret.

### Reference signer (Node / Web Crypto compatible)

```ts
import { createHmac } from "crypto";

function signBridgeRequest(secret: string, actor: object, rawBody = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const actorJson = JSON.stringify(actor);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${actorJson}.${rawBody}`)
    .digest("hex");
  return {
    "x-timestamp": timestamp,
    "x-actor": actorJson,
    "x-signature": signature,
    "Content-Type": "application/json",
  };
}
```

### Common auth failures

| Status | Meaning                                              |
| ------ | --------------------------------------------------- |
| 401    | Missing headers / stale timestamp / invalid signature / bad actor |
| 403    | Actor role not permitted for the action             |
| 409    | Optimistic-concurrency conflict on a write          |
| 503    | Bridge not configured (secret missing on the server) |

---

## 4. Endpoints

All endpoints support `OPTIONS` (CORS preflight). Responses are always sent
with `Cache-Control: no-store` so the partner never renders a stale snapshot.

### Diagnostics (unauthenticated — safe to poll)

| Method | Path                                 | Purpose |
| ------ | ------------------------------------ | ------- |
| GET    | `/api/public/bridge/health`          | Reports whether the shared secret & partner URL are configured (never their values) and the exact `patient_field_keys` the patients endpoint serializes, so you can verify schema compatibility. No patient data. |
| GET    | `/api/public/bridge/verify-signature`| Self-signs a synthetic envelope with the current secret and confirms it validates (and that a tampered signature is rejected). Reports `rotation_window_active`. |
| POST   | `/api/public/bridge/verify-signature`| Validates a signature **you** produced. Send the real bridge headers; the body is verified verbatim. Use this to prove your signer is compatible before touching live data. |

### Clinical data (authenticated)

| Method | Path                                   | Roles  | Notes |
| ------ | -------------------------------------- | ------ | ----- |
| GET    | `/api/public/bridge/patients`          | read   | List patients. Optional `?status=admitted\|referred\|discharged\|died`. Ordered by `updated_at` desc. |
| POST   | `/api/public/bridge/patients`          | write  | Upsert a patient. Supports optimistic concurrency via `expected_updated_at` (→ 409 on conflict). Empty strings are stored as null. |
| GET    | `/api/public/bridge/investigations`    | read   | Optional `?patient_id=` and/or `?category=`. |
| POST   | `/api/public/bridge/investigations`    | write  | Upsert a single investigation. |
| GET    | `/api/public/bridge/microbiology`      | read   | Recent microbiology results (capped). |
| GET    | `/api/public/bridge/referrals`         | read   | Referral records (capped). |
| GET    | `/api/public/bridge/beds`              | read   | ICU bed board / occupancy snapshot. |
| GET    | `/api/public/bridge/audit`             | read   | Recent audit-log entries (capped). |
| GET    | `/api/public/bridge/notifications`     | read   | Recent notifications (capped). |

### Scheduled sync trigger

| Method | Path                              | Auth |
| ------ | --------------------------------- | ---- |
| POST   | `/api/public/hooks/bridge-sync`   | Header `x-bridge-secret` matching **either** `HANDOVER_API_SECRET` (partner-triggered) or `BRIDGE_SYNC_CRON_SECRET` (this backend's pg_cron). Response is aggregate counts only — no patient data. |

This hook uses a plain shared-secret header (not the HMAC actor envelope),
because it is a machine-to-machine trigger with no acting user.

---

## 5. Patient write payload

`POST /api/public/bridge/patients` accepts (all optional unless noted):

```
id?                      uuid (omit to create)
expected_updated_at?     string  // last-seen updated_at; enables 409 conflict guard
full_name                string (required, 1–200)
hospital_number?         string
age?                     0–130
location_type?           "icu" | "outlier"
ward? / bed?             string
status?                  "referred" | "admitted" | "discharged" | "died"
admission_date? / discharge_date? / discharge_destination? / date_of_death?
past_medical_history? / current_admission? / current_management? / outstanding_tasks?
tep_in_place? (bool) / tep_details?
dnacpr_decision? (bool) / dnacpr_details? / dnacpr_date?
nok_name? / nok_relationship? / nok_contact? / nok_last_updated? / nok_last_updated_by?
```

The authoritative serialized field list is returned live by
`GET /api/public/bridge/health` (`patient_field_keys`).

---

## 6. Sync observability

Successful and failed bridge exchanges are recorded to `bridge_sync_events`
(direction `push`/`pull`, entity, record count, actor role/email, status, and
truncated error message) and surfaced in the app's **Sync status** panel.
Logging is best-effort and never blocks or fails the underlying data operation.

---

## 7. Integration checklist

1. Confirm `GET /api/public/bridge/health` reports
   `handover_api_secret_configured: true`.
2. Sign a test envelope and confirm `POST /api/public/bridge/verify-signature`
   returns `signature_valid: true`.
3. Confirm your serialized `patients` fields match `patient_field_keys` from
   the health endpoint.
4. Start with read endpoints; add writes once the signer is verified.
5. Never cache responses; keep all secrets server-side only.
