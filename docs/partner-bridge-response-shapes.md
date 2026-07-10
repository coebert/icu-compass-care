# Partner Bridge — Exact JSON Response Shapes

Companion to `docs/partner-bridge-handoff.md`. This document specifies the
**exact JSON body** every `/api/public/bridge/*` endpoint returns, including
which fields are nullable and worked example responses. It is generated from
the live route handlers (`src/routes/api/public/bridge.*.ts`), the shared auth
helper (`src/lib/api-bridge.server.ts`), and the database column definitions.

## Conventions

- All timestamps are ISO-8601 UTC strings (`2026-07-10T22:14:03.512Z`), sourced
  from Postgres `timestamptz`.
- Date-only fields (`admission_date`, `discharge_date`, `date_of_death`) are
  `YYYY-MM-DD` strings.
- `uuid` fields are lowercase 36-char UUID strings.
- **Nullable** means the JSON value may be `null`. Fields marked NOT NULL are
  always present with a non-null value.
- Every successful response carries these headers:
  - `Content-Type: application/json`
  - `Access-Control-Allow-Origin: *` (+ the other `CORS_HEADERS`)
  - `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`
- The bridge serializes rows with `select("*")`, so read endpoints return **all
  table columns**, not a curated subset (except `beds`, which projects a slim
  occupant view — see below).

## Shared error shape

Every endpoint returns errors as `{ "error": string }` (plus extra keys on the
`409` conflict). Status codes come from `authorize()` and each handler:

| Status | When | Body |
| --- | --- | --- |
| `400` | Body fails Zod validation (write endpoints) | `{ "error": "Invalid patient payload" }` / `"Invalid investigation payload"` |
| `401` | Missing headers, stale/invalid timestamp (>300s skew), or bad signature | `{ "error": "Missing authentication headers" }` / `"Stale or invalid timestamp"` / `"Invalid signature" }` |
| `401` | Actor JSON missing `id`/`role` | `{ "error": "Missing or invalid user context" }` |
| `403` | Actor role not permitted for the action | `{ "error": "Insufficient role for this action" }` |
| `404` | Update/target patient id not found | `{ "error": "Patient not found" }` |
| `409` | Optimistic-concurrency conflict on patient update | see `POST /patients` below |
| `500` | Unexpected DB error | `{ "error": "Internal server error" }` |
| `503` | `HANDOVER_API_SECRET` not configured | `{ "error": "Bridge not configured" }` |

Recognised roles: reads allow `admin` and `clinician`; writes allow `admin` and
`clinician`.

---

## `GET /api/public/bridge/health` — unauthenticated

Diagnostic. No auth headers required. Never returns patient data or the secret
value.

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | always `true` |
| `service` | string | always `"bridge"` |
| `handover_api_secret_configured` | boolean | whether `HANDOVER_API_SECRET` is set |
| `partner_bridge_url_configured` | boolean | whether `PARTNER_BRIDGE_URL` is set |
| `patient_field_keys` | string[] | the exact keys `GET /patients` serializes |
| `patient_field_count` | number | `patient_field_keys.length` |
| `timestamp` | string (ISO) | server time |

```json
{
  "ok": true,
  "service": "bridge",
  "handover_api_secret_configured": true,
  "partner_bridge_url_configured": false,
  "patient_field_keys": [
    "id", "created_by", "updated_by", "full_name", "hospital_number", "age",
    "location_type", "ward", "bed", "status", "admission_date",
    "discharge_date", "discharge_destination", "date_of_death",
    "past_medical_history", "current_admission", "current_management",
    "outstanding_tasks", "tep_in_place", "tep_details", "dnacpr_decision",
    "dnacpr_details", "dnacpr_date", "nok_name", "nok_relationship",
    "nok_contact", "nok_last_updated", "nok_last_updated_by",
    "created_at", "updated_at"
  ],
  "patient_field_count": 30,
  "timestamp": "2026-07-10T22:14:03.512Z"
}
```

---

## `GET /api/public/bridge/verify-signature` — unauthenticated self-test

Signs a synthetic envelope with the current secret and runs it through
`authorize()`. Returns `200` when the self-test passes, `500` when it fails,
`503` when the secret is not configured. **Never returns a reusable
signature.**

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | `true` only if valid accepted AND tampered rejected |
| `handover_api_secret_configured` | boolean | always `true` in the `200` path |
| `rotation_window_active` | boolean | whether `HANDOVER_API_SECRET_PREVIOUS` is set |
| `checks.valid_signature_accepted` | boolean | |
| `checks.tampered_signature_rejected` | boolean | |
| `envelope.message_format` | string | the signing formula, literal |
| `envelope.raw_body` | string | `""` for this GET self-test |
| `timestamp` | string (ISO) | |

```json
{
  "ok": true,
  "handover_api_secret_configured": true,
  "rotation_window_active": false,
  "checks": {
    "valid_signature_accepted": true,
    "tampered_signature_rejected": true
  },
  "envelope": {
    "message_format": "`${x-timestamp}.${x-actor}.${rawBody}`",
    "raw_body": ""
  },
  "timestamp": "2026-07-10T22:14:03.512Z"
}
```

Not-configured response (`503`):

```json
{ "ok": false, "error": "HANDOVER_API_SECRET not configured", "handover_api_secret_configured": false }
```

## `POST /api/public/bridge/verify-signature` — signed

Validates the signature on the request **you** send (the body is verified
verbatim). Returns `200` when your signature validates, otherwise the shared
`authorize()` error (`401`/`403`).

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | always `true` on success |
| `signature_valid` | boolean | always `true` on success |
| `actor` | object | the forwarded actor: `{ id, email?, role }` |
| `actor.id` | string (uuid) | |
| `actor.email` | string \| omitted | present only if you sent it |
| `actor.role` | string | e.g. `"clinician"` |
| `timestamp` | string (ISO) | |

```json
{
  "ok": true,
  "signature_valid": true,
  "actor": { "id": "…uuid…", "email": "nurse@trust.nhs.uk", "role": "clinician" },
  "timestamp": "2026-07-10T22:14:03.512Z"
}
```

---

## `GET /api/public/bridge/patients` — signed (read)

Returns `{ "patients": PatientRow[] }`, ordered by `updated_at` descending.
Optional query filter `?status=admitted|referred|discharged|died`.

### `PatientRow` shape

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | |
| `created_by` | string (uuid) | **yes** | null for bridge/system-created rows |
| `updated_by` | string (uuid) | **yes** | |
| `full_name` | string | no | |
| `hospital_number` | string | **yes** | |
| `age` | number (int) | **yes** | 0–130 |
| `location_type` | `"icu"` \| `"outlier"` | no | enum |
| `ward` | string | **yes** | |
| `bed` | string | **yes** | |
| `status` | `"referred"` \| `"admitted"` \| `"discharged"` \| `"died"` | no | enum |
| `admission_date` | string (date) | **yes** | |
| `discharge_date` | string (date) | **yes** | |
| `discharge_destination` | string | **yes** | |
| `date_of_death` | string (date) | **yes** | |
| `past_medical_history` | string | **yes** | |
| `current_admission` | string | **yes** | |
| `current_management` | string | **yes** | |
| `outstanding_tasks` | string | **yes** | |
| `tep_in_place` | boolean | no | defaults `false` |
| `tep_details` | string | **yes** | |
| `dnacpr_decision` | boolean | no | defaults `false` |
| `dnacpr_details` | string | **yes** | |
| `dnacpr_date` | string (date) | **yes** | |
| `nok_name` | string | **yes** | |
| `nok_relationship` | string | **yes** | |
| `nok_contact` | string | **yes** | |
| `nok_last_updated` | string (ISO) | **yes** | |
| `nok_last_updated_by` | string | **yes** | |
| `created_at` | string (ISO) | no | |
| `updated_at` | string (ISO) | no | used for optimistic concurrency |

```json
{
  "patients": [
    {
      "id": "b1c2…",
      "created_by": null,
      "updated_by": null,
      "full_name": "Jane Doe",
      "hospital_number": "RSH1234567",
      "age": 62,
      "location_type": "icu",
      "ward": "Critical Care",
      "bed": "Bed 4",
      "status": "admitted",
      "admission_date": "2026-07-08",
      "discharge_date": null,
      "discharge_destination": null,
      "date_of_death": null,
      "past_medical_history": "COPD, T2DM",
      "current_admission": "Community-acquired pneumonia",
      "current_management": "HFNO, IV co-amoxiclav",
      "outstanding_tasks": "Repeat ABG at 18:00",
      "tep_in_place": true,
      "tep_details": "For ward-based escalation only",
      "dnacpr_decision": false,
      "dnacpr_details": null,
      "dnacpr_date": null,
      "nok_name": "John Doe",
      "nok_relationship": "Husband",
      "nok_contact": "07700 900000",
      "nok_last_updated": "2026-07-09T10:02:00.000Z",
      "nok_last_updated_by": "S. Nurse",
      "created_at": "2026-07-08T09:00:00.000Z",
      "updated_at": "2026-07-10T21:40:11.220Z"
    }
  ]
}
```

## `POST /api/public/bridge/patients` — signed (write)

Upsert. When `id` is omitted a row is inserted; when present the row is updated.
Non-column control fields in the payload: `expected_updated_at` (optimistic
concurrency; not stored). Empty strings are coerced to `null`.

**Success (`200`)** returns the single affected row under `patient` (same shape
as `PatientRow` above):

```json
{ "patient": { "id": "b1c2…", "full_name": "Jane Doe", "status": "admitted", "updated_at": "2026-07-10T21:59:02.010Z", "…": "…all PatientRow fields…" } }
```

**Conflict (`409`)** when `expected_updated_at` no longer matches the stored
`updated_at`:

| Field | Type | Notes |
| --- | --- | --- |
| `error` | string | always `"conflict"` |
| `message` | string | human-readable reconcile hint |
| `current` | PatientRow | the current server-side row |
| `your_expected_updated_at` | string | the stale value you sent |

```json
{
  "error": "conflict",
  "message": "This patient was modified since you last loaded it.",
  "current": { "id": "b1c2…", "updated_at": "2026-07-10T21:59:02.010Z", "…": "…full PatientRow…" },
  "your_expected_updated_at": "2026-07-10T21:40:11.220Z"
}
```

Other failures: `400` invalid payload, `404` `{ "error": "Patient not found" }`,
`500` `{ "error": "Patient could not be created" }` / `"Internal server error"`.

---

## `GET /api/public/bridge/investigations` — signed (read)

Returns `{ "investigations": InvestigationRow[] }`, ordered by `result_at`
descending. Optional filters: `?patient_id=<uuid>`, `?category=<string>`.

### `InvestigationRow` shape

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | |
| `patient_id` | string (uuid) | no | |
| `category` | string | no | e.g. `"Bloods"`, `"CXR"`, `"CT Chest"` |
| `findings` | string | no | |
| `result_at` | string (ISO) | no | defaults to now on insert if omitted |
| `created_by` | string (uuid) | **yes** | |
| `created_at` | string (ISO) | no | |
| `updated_at` | string (ISO) | no | |

```json
{
  "investigations": [
    {
      "id": "e3f4…",
      "patient_id": "b1c2…",
      "category": "Bloods",
      "findings": "Hb 118, WCC 14.2, CRP 210",
      "result_at": "2026-07-10T08:30:00.000Z",
      "created_by": null,
      "created_at": "2026-07-10T08:31:12.000Z",
      "updated_at": "2026-07-10T08:31:12.000Z"
    }
  ]
}
```

## `POST /api/public/bridge/investigations` — signed (write)

Append-only insert. Payload: `patient_id` (uuid, required), `category`
(1–100 chars), `findings` (1–20000 chars), `result_at` (optional ISO; defaults
to now). Returns the created row under `investigation` (same shape as
`InvestigationRow`):

```json
{ "investigation": { "id": "e3f4…", "patient_id": "b1c2…", "category": "Bloods", "findings": "…", "result_at": "2026-07-10T08:30:00.000Z", "created_by": null, "created_at": "…", "updated_at": "…" } }
```

Failure: `400 { "error": "Invalid investigation payload" }`, `500` on DB error.

---

## `GET /api/public/bridge/microbiology` — signed (read)

Returns `{ "microbiology": MicrobiologyRow[] }`, ordered by `updated_at`
descending, capped at 5000 rows. Read-only (no POST).

### `MicrobiologyRow` shape

| Field | Type | Nullable |
| --- | --- | --- |
| `id` | string (uuid) | no |
| `patient_id` | string (uuid) | no |
| `specimen_type` | string | no |
| `findings` | string | no |
| `result_at` | string (ISO) | no |
| `created_by` | string (uuid) | **yes** |
| `created_at` | string (ISO) | no |
| `updated_at` | string (ISO) | no |

```json
{
  "microbiology": [
    {
      "id": "aa11…",
      "patient_id": "b1c2…",
      "specimen_type": "Sputum",
      "findings": "Scanty growth of normal respiratory flora",
      "result_at": "2026-07-09T14:00:00.000Z",
      "created_by": null,
      "created_at": "2026-07-09T14:05:00.000Z",
      "updated_at": "2026-07-09T14:05:00.000Z"
    }
  ]
}
```

---

## `GET /api/public/bridge/referrals` — signed (read)

Returns `{ "referrals": ReferralRow[] }`, ordered by `updated_at` descending,
capped at 2000 rows. Read-only. Row shape is the full `referrals` table
(`select("*")`); every column is returned. Timestamps `created_at`/`updated_at`
are NOT NULL; foreign-key/optional columns may be `null`.

```json
{
  "referrals": [
    {
      "id": "cc33…",
      "patient_id": "b1c2…",
      "created_at": "2026-07-08T11:00:00.000Z",
      "updated_at": "2026-07-08T11:00:00.000Z"
    }
  ]
}
```

---

## `GET /api/public/bridge/audit` — signed (read)

Returns `{ "audit_log": AuditRow[] }`, ordered by `created_at` descending,
capped at 2000 rows. Append-only, read-only.

### `AuditRow` shape

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | |
| `user_id` | string (uuid) | **yes** | null for bridge/system actions |
| `action` | string (enum) | no | e.g. `"insert"`, `"update"` |
| `entity` | string | no | e.g. `"patients"`, `"investigations"` |
| `entity_id` | string (uuid) | **yes** | |
| `diff` | object (jsonb) | **yes** | before/after snapshot |
| `created_at` | string (ISO) | no | |

```json
{
  "audit_log": [
    {
      "id": "dd44…",
      "user_id": null,
      "action": "update",
      "entity": "patients",
      "entity_id": "b1c2…",
      "diff": { "before": { "status": "referred" }, "after": { "status": "admitted" } },
      "created_at": "2026-07-10T21:59:02.010Z"
    }
  ]
}
```

---

## `GET /api/public/bridge/notifications` — signed (read)

Returns `{ "notifications": NotificationRow[] }`, ordered by `created_at`
descending, capped at 2000 rows. Read-only.

### `NotificationRow` shape

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | no | |
| `user_id` | string (uuid) | no | recipient |
| `referral_id` | string (uuid) | **yes** | |
| `kind` | string | no | |
| `message` | string | no | |
| `read_at` | string (ISO) | **yes** | null while unread |
| `created_at` | string (ISO) | no | |

```json
{
  "notifications": [
    {
      "id": "ee55…",
      "user_id": "ff66…",
      "referral_id": "cc33…",
      "kind": "referral_created",
      "message": "New outlier referral for review",
      "read_at": null,
      "created_at": "2026-07-10T12:00:00.000Z"
    }
  ]
}
```

---

## `GET /api/public/bridge/beds` — signed (read)

Bed board snapshot. Unlike the other reads, occupants are a **slim projection**
(`occupantView`), not full patient rows.

### Top-level shape

| Field | Type | Notes |
| --- | --- | --- |
| `unit` | string | always `"Radnor Critical Care Unit"` |
| `side_rooms` | string[] | labels of roster beds flagged as side rooms |
| `bed_board` | BedSlot[] | one entry per roster bed, in `position` order |
| `unassigned` | Occupant[] | active ICU patients whose `bed` matches no roster slot |
| `stats.total_beds` | number | |
| `stats.occupied` | number | |
| `stats.available` | number | `total_beds - occupied` |
| `stats.unassigned` | number | `unassigned.length` |

### `BedSlot` shape

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `bed` | string | no | roster label |
| `is_side_room` | boolean | no | |
| `occupied` | boolean | no | |
| `occupant` | Occupant \| null | **yes** | null when the bed is empty |

### `Occupant` shape (slim projection)

| Field | Type | Nullable |
| --- | --- | --- |
| `id` | string (uuid) | no |
| `full_name` | string | **yes** |
| `hospital_number` | string | **yes** |
| `age` | number | **yes** |
| `status` | string | **yes** |
| `bed` | string | **yes** |
| `admission_date` | string (date) | **yes** |
| `tep_in_place` | boolean | **yes** |
| `dnacpr_decision` | boolean | **yes** |
| `outstanding_tasks` | string | **yes** |
| `updated_at` | string (ISO) | **yes** |

```json
{
  "unit": "Radnor Critical Care Unit",
  "side_rooms": ["Side Room 1", "Side Room 2"],
  "bed_board": [
    {
      "bed": "Bed 1",
      "is_side_room": false,
      "occupied": true,
      "occupant": {
        "id": "b1c2…",
        "full_name": "Jane Doe",
        "hospital_number": "RSH1234567",
        "age": 62,
        "status": "admitted",
        "bed": "Bed 1",
        "admission_date": "2026-07-08",
        "tep_in_place": true,
        "dnacpr_decision": false,
        "outstanding_tasks": "Repeat ABG at 18:00",
        "updated_at": "2026-07-10T21:40:11.220Z"
      }
    },
    { "bed": "Bed 2", "is_side_room": false, "occupied": false, "occupant": null }
  ],
  "unassigned": [
    {
      "id": "99aa…",
      "full_name": "Unbedded Patient",
      "hospital_number": null,
      "age": 47,
      "status": "referred",
      "bed": "Corridor",
      "admission_date": "2026-07-10",
      "tep_in_place": false,
      "dnacpr_decision": false,
      "outstanding_tasks": null,
      "updated_at": "2026-07-10T20:00:00.000Z"
    }
  ],
  "stats": { "total_beds": 12, "occupied": 1, "available": 11, "unassigned": 1 }
}
```

---

## Contract test

`tests/e2e/bridge-endpoints-signed-actor-contract.e2e.py` exercises every
endpoint above with real signed-actor auth and asserts these response shapes,
so a regression to any field or status code fails the suite.
