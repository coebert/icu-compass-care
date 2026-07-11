// OpenAPI 3.1 specification for the cross-project data bridge.
//
// OpenAPI 3.1 is a strict superset of JSON Schema 2020-12, so `components.schemas`
// here double as standalone JSON Schemas for every documented response shape.
// This object is pure data (no secrets) and is served verbatim from
// GET /api/public/bridge/openapi.
//
// Keep the response schemas in sync with the handlers under
// src/routes/api/public/bridge.*.ts and the row types in
// src/integrations/supabase/types.ts.

// Reusable field fragments -------------------------------------------------

const nullableString = { type: ["string", "null"] } as const;
const nullableNumber = { type: ["number", "null"] } as const;
const nullableBool = { type: ["boolean", "null"] } as const;

// Slim occupant projection returned by /beds.
const OccupantView = {
  type: "object",
  description: "Slim patient projection for the bed board (not the full record).",
  properties: {
    id: { type: "string", format: "uuid" },
    full_name: nullableString,
    hospital_number: nullableString,
    age: nullableNumber,
    status: nullableString,
    bed: nullableString,
    admission_date: nullableString,
    tep_in_place: nullableBool,
    dnacpr_decision: nullableBool,
    outstanding_tasks: nullableString,
    updated_at: nullableString,
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const Patient = {
  type: "object",
  description: "A critical-care patient record as serialized by GET /patients (select *).",
  properties: {
    id: { type: "string", format: "uuid" },
    created_by: nullableString,
    updated_by: nullableString,
    full_name: { type: "string" },
    hospital_number: nullableString,
    age: nullableNumber,
    location_type: { type: ["string", "null"], enum: ["icu", "outlier", null] },
    ward: nullableString,
    bed: nullableString,
    status: { type: ["string", "null"], enum: ["referred", "admitted", "discharged", "died", null] },
    admission_date: nullableString,
    discharge_date: nullableString,
    discharge_destination: nullableString,
    date_of_death: nullableString,
    past_medical_history: nullableString,
    current_admission: nullableString,
    current_management: nullableString,
    outstanding_tasks: nullableString,
    systems_resp: nullableString,
    resp_fio2: nullableString,
    systems_cvs: nullableString,
    systems_neuro: nullableString,
    systems_renal: nullableString,
    systems_gastro: nullableString,
    systems_haem: nullableString,
    systems_micro: nullableString,
    systems_other: nullableString,
    tep_in_place: { type: "boolean" },
    tep_details: nullableString,
    dnacpr_decision: { type: "boolean" },
    dnacpr_details: nullableString,
    dnacpr_date: nullableString,
    nok_name: nullableString,
    nok_relationship: nullableString,
    nok_contact: nullableString,
    nok_last_updated: nullableString,
    nok_last_updated_by: nullableString,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "full_name", "created_at", "updated_at"],
  additionalProperties: true,
} as const;

const PatientUpsert = {
  type: "object",
  description: "Create/update payload for POST /patients (upsert by id when provided).",
  properties: {
    id: { type: "string", format: "uuid", description: "Omit to create; provide to update." },
    expected_updated_at: {
      type: "string",
      description: "Optimistic-concurrency guard: the updated_at the caller last saw. The write is rejected with 409 if the record changed since then.",
    },
    full_name: { type: "string", minLength: 1, maxLength: 200 },
    hospital_number: { type: ["string", "null"], maxLength: 50 },
    age: { type: ["integer", "null"], minimum: 0, maximum: 130 },
    location_type: { type: "string", enum: ["icu", "outlier"] },
    ward: { type: ["string", "null"], maxLength: 100 },
    bed: { type: ["string", "null"], maxLength: 50 },
    status: { type: "string", enum: ["referred", "admitted", "discharged", "died"] },
    admission_date: nullableString,
    discharge_date: nullableString,
    discharge_destination: { type: ["string", "null"], maxLength: 300 },
    date_of_death: nullableString,
    past_medical_history: { type: ["string", "null"], maxLength: 10000 },
    current_admission: { type: ["string", "null"], maxLength: 10000 },
    current_management: { type: ["string", "null"], maxLength: 10000 },
    outstanding_tasks: { type: ["string", "null"], maxLength: 10000 },
    systems_resp: { type: ["string", "null"], maxLength: 10000 },
    resp_fio2: { type: ["string", "null"], maxLength: 50 },
    systems_cvs: { type: ["string", "null"], maxLength: 10000 },
    systems_neuro: { type: ["string", "null"], maxLength: 10000 },
    systems_renal: { type: ["string", "null"], maxLength: 10000 },
    systems_gastro: { type: ["string", "null"], maxLength: 10000 },
    systems_haem: { type: ["string", "null"], maxLength: 10000 },
    systems_micro: { type: ["string", "null"], maxLength: 10000 },
    systems_other: { type: ["string", "null"], maxLength: 10000 },
    tep_in_place: { type: "boolean" },
    tep_details: { type: ["string", "null"], maxLength: 10000 },
    dnacpr_decision: { type: "boolean" },
    dnacpr_details: { type: ["string", "null"], maxLength: 10000 },
    dnacpr_date: nullableString,
    nok_name: { type: ["string", "null"], maxLength: 200 },
    nok_relationship: { type: ["string", "null"], maxLength: 100 },
    nok_contact: { type: ["string", "null"], maxLength: 200 },
    nok_last_updated: nullableString,
    nok_last_updated_by: { type: ["string", "null"], maxLength: 200 },
  },
  required: ["full_name"],
  additionalProperties: false,
} as const;

const Investigation = {
  type: "object",
  description: "An investigation result row.",
  properties: {
    id: { type: "string", format: "uuid" },
    patient_id: { type: "string", format: "uuid" },
    category: { type: "string" },
    findings: { type: "string" },
    result_at: { type: "string", format: "date-time" },
    created_by: nullableString,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "patient_id", "category", "findings", "result_at", "created_at", "updated_at"],
  additionalProperties: true,
} as const;

const InvestigationInsert = {
  type: "object",
  description: "Append-only investigation payload for POST /investigations.",
  properties: {
    patient_id: { type: "string", format: "uuid" },
    category: { type: "string", minLength: 1, maxLength: 100 },
    findings: { type: "string", minLength: 1, maxLength: 20000 },
    result_at: { type: ["string", "null"], description: "Defaults to now when omitted." },
  },
  required: ["patient_id", "category", "findings"],
  additionalProperties: false,
} as const;

const Microbiology = {
  type: "object",
  description: "A microbiology result row.",
  properties: {
    id: { type: "string", format: "uuid" },
    patient_id: { type: "string", format: "uuid" },
    specimen_type: { type: "string" },
    findings: { type: "string" },
    result_at: { type: "string", format: "date-time" },
    created_by: nullableString,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "patient_id", "specimen_type", "findings", "result_at", "created_at", "updated_at"],
  additionalProperties: true,
} as const;

const Notification = {
  type: "object",
  description: "A notification row.",
  properties: {
    id: { type: "string", format: "uuid" },
    user_id: { type: "string", format: "uuid" },
    kind: { type: "string" },
    message: { type: "string" },
    referral_id: { type: ["string", "null"], format: "uuid" },
    read_at: nullableString,
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "user_id", "kind", "message", "created_at"],
  additionalProperties: true,
} as const;

const AuditLogEntry = {
  type: "object",
  description: "An append-only audit-log row.",
  properties: {
    id: { type: "string", format: "uuid" },
    entity: { type: "string" },
    entity_id: { type: ["string", "null"] },
    action: { type: "string", enum: ["insert", "update", "delete"] },
    diff: { type: ["object", "null"], additionalProperties: true },
    user_id: { type: ["string", "null"], format: "uuid" },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "entity", "action", "created_at"],
  additionalProperties: true,
} as const;

const Referral = {
  type: "object",
  description:
    "A referral row (select *). Encrypted/hashed columns (suffixes _enc / _hash) are opaque and not human-readable.",
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string" },
    outcome: nullableString,
    referral_received_at: { type: "string", format: "date-time" },
    referring_specialty: nullableString,
    accepting_consultant: nullableString,
    current_ward: nullableString,
    current_bed: nullableString,
    age: nullableNumber,
    sex: nullableString,
    news2_score: nullableNumber,
    news2_recorded_at: nullableString,
    frailty_score: nullableNumber,
    weight_kg: nullableNumber,
    admission_urgency: nullableString,
    ceiling_of_care: nullableString,
    resus_status: nullableString,
    infection_status: nullableString,
    infection_organism: nullableString,
    reason_category: nullableString,
    anticipated_interventions: { type: "array", items: { type: "string" } },
    consultant_to_consultant_only: { type: "boolean" },
    dnacpr_respect: { type: "boolean" },
    for_ongoing_ccot_review: { type: "boolean" },
    needs_ward_review: { type: "boolean" },
    is_test: { type: "boolean" },
    first_seen_at: nullableString,
    decision_at: nullableString,
    outcome_recorded_at: nullableString,
    arrived_on_unit_at: nullableString,
    deleted_at: nullableString,
    created_by: nullableString,
    updated_by: nullableString,
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "status", "referral_received_at", "created_at", "updated_at"],
  additionalProperties: true,
} as const;

const Bed = {
  type: "object",
  properties: {
    bed: { type: "string" },
    is_side_room: { type: "boolean" },
    occupied: { type: "boolean" },
    occupant: { oneOf: [{ $ref: "#/components/schemas/OccupantView" }, { type: "null" }] },
  },
  required: ["bed", "is_side_room", "occupied", "occupant"],
  additionalProperties: false,
} as const;

const ErrorResponse = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
  required: ["error"],
  additionalProperties: true,
} as const;

// The signed-actor security requirement shared by every authenticated endpoint.
const bridgeSecurity = [{ x_timestamp: [], x_actor: [], x_signature: [] }];

const authHeaderResponses = {
  "401": {
    description: "Missing/invalid signature, actor, or timestamp.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "403": {
    description: "Actor role is not permitted for this action.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "500": {
    description: "Internal server error.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "503": {
    description: "Bridge not configured (shared secret missing).",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
} as const;

const okObject = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const bridgeOpenApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "ICU Handover — Cross-project Data Bridge API",
    version: "1.0.0",
    description:
      "Public bridge endpoints for the linked partner project. Every endpoint except " +
      "GET /health and GET /verify-signature requires a signed request: an HMAC-SHA256 " +
      "signature over `${x-timestamp}.${x-actor}.${rawBody}` using the shared secret, plus a " +
      "signed actor envelope (`x-actor` = JSON { id, email, role }). Timestamps must be within " +
      "300 seconds. Read roles: admin, clinician. Write roles: admin, clinician.",
  },
  servers: [
    { url: "https://icu-compass-care.lovable.app", description: "Published" },
    { url: "https://project--58df96bd-2803-4146-90a7-4a08f526bece.lovable.app", description: "Stable preview" },
  ],
  tags: [
    { name: "clinical", description: "Patient, investigation, referral and microbiology data" },
    { name: "operations", description: "Bed board, audit, notifications" },
    { name: "diagnostics", description: "Health and signature self-test (unauthenticated)" },
  ],
  components: {
    securitySchemes: {
      x_timestamp: { type: "apiKey", in: "header", name: "x-timestamp", description: "Unix seconds; must be within 300s of server time." },
      x_actor: { type: "apiKey", in: "header", name: "x-actor", description: "JSON { id, email, role } of the acting user." },
      x_signature: { type: "apiKey", in: "header", name: "x-signature", description: "hex HMAC-SHA256 of `${x-timestamp}.${x-actor}.${rawBody}`." },
    },
    schemas: {
      OccupantView,
      Patient,
      PatientUpsert,
      Investigation,
      InvestigationInsert,
      Microbiology,
      Notification,
      AuditLogEntry,
      Referral,
      Bed,
      Error: ErrorResponse,
      BedBoardResponse: {
        type: "object",
        properties: {
          unit: { type: "string" },
          side_rooms: { type: "array", items: { type: "string" } },
          bed_board: { type: "array", items: { $ref: "#/components/schemas/Bed" } },
          unassigned: { type: "array", items: { $ref: "#/components/schemas/OccupantView" } },
          stats: {
            type: "object",
            properties: {
              total_beds: { type: "integer" },
              occupied: { type: "integer" },
              available: { type: "integer" },
              unassigned: { type: "integer" },
            },
            required: ["total_beds", "occupied", "available", "unassigned"],
            additionalProperties: false,
          },
        },
        required: ["unit", "side_rooms", "bed_board", "unassigned", "stats"],
        additionalProperties: false,
      },
      HealthResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          service: { type: "string" },
          handover_api_secret_configured: { type: "boolean" },
          partner_bridge_url_configured: { type: "boolean" },
          patient_field_keys: { type: "array", items: { type: "string" } },
          patient_field_count: { type: "integer" },
          timestamp: { type: "string", format: "date-time" },
        },
        required: ["ok", "service", "handover_api_secret_configured", "patient_field_keys", "patient_field_count", "timestamp"],
        additionalProperties: false,
      },
      VerifySignatureSelfTest: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          handover_api_secret_configured: { type: "boolean" },
          rotation_window_active: { type: "boolean" },
          checks: {
            type: "object",
            properties: {
              valid_signature_accepted: { type: "boolean" },
              tampered_signature_rejected: { type: "boolean" },
            },
            additionalProperties: false,
          },
          envelope: {
            type: "object",
            properties: { message_format: { type: "string" }, raw_body: { type: "string" } },
            additionalProperties: false,
          },
          timestamp: { type: "string", format: "date-time" },
        },
        required: ["ok", "timestamp"],
        additionalProperties: true,
      },
      VerifySignatureResult: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          signature_valid: { type: "boolean" },
          actor: {
            type: "object",
            properties: { id: { type: "string" }, email: nullableString, role: { type: "string" } },
            required: ["id", "role"],
            additionalProperties: false,
          },
          timestamp: { type: "string", format: "date-time" },
        },
        required: ["ok", "signature_valid", "actor", "timestamp"],
        additionalProperties: false,
      },
    },
  },
  security: bridgeSecurity,
  paths: {
    "/api/public/bridge/patients": {
      get: {
        tags: ["clinical"],
        summary: "List patients",
        parameters: [
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["referred", "admitted", "discharged", "died"] },
          },
        ],
        responses: {
          "200": okObject(
            { type: "object", properties: { patients: { type: "array", items: { $ref: "#/components/schemas/Patient" } } }, required: ["patients"] },
            "The patient list.",
          ),
          ...authHeaderResponses,
        },
      },
      post: {
        tags: ["clinical"],
        summary: "Create or update a patient (upsert by id)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/PatientUpsert" } } },
        },
        responses: {
          "200": okObject(
            { type: "object", properties: { patient: { $ref: "#/components/schemas/Patient" } }, required: ["patient"] },
            "The created/updated patient.",
          ),
          "400": okObject({ $ref: "#/components/schemas/Error" }, "Invalid patient payload."),
          "404": okObject({ $ref: "#/components/schemas/Error" }, "Patient not found (on update)."),
          "409": okObject(
            {
              type: "object",
              properties: {
                error: { type: "string", const: "conflict" },
                message: { type: "string" },
                current: { $ref: "#/components/schemas/Patient" },
                your_expected_updated_at: { type: "string" },
              },
              required: ["error", "message", "current"],
            },
            "Optimistic-concurrency conflict: the record changed since expected_updated_at.",
          ),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/investigations": {
      get: {
        tags: ["clinical"],
        summary: "List investigations",
        parameters: [
          { name: "patient_id", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "category", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": okObject(
            { type: "object", properties: { investigations: { type: "array", items: { $ref: "#/components/schemas/Investigation" } } }, required: ["investigations"] },
            "The investigation list.",
          ),
          ...authHeaderResponses,
        },
      },
      post: {
        tags: ["clinical"],
        summary: "Add an investigation result (append-only)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/InvestigationInsert" } } },
        },
        responses: {
          "200": okObject(
            { type: "object", properties: { investigation: { $ref: "#/components/schemas/Investigation" } }, required: ["investigation"] },
            "The created investigation.",
          ),
          "400": okObject({ $ref: "#/components/schemas/Error" }, "Invalid investigation payload."),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/microbiology": {
      get: {
        tags: ["clinical"],
        summary: "List microbiology results",
        responses: {
          "200": okObject(
            { type: "object", properties: { microbiology: { type: "array", items: { $ref: "#/components/schemas/Microbiology" } } }, required: ["microbiology"] },
            "The microbiology result list.",
          ),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/referrals": {
      get: {
        tags: ["clinical"],
        summary: "List referrals",
        responses: {
          "200": okObject(
            { type: "object", properties: { referrals: { type: "array", items: { $ref: "#/components/schemas/Referral" } } }, required: ["referrals"] },
            "The referral list.",
          ),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/beds": {
      get: {
        tags: ["operations"],
        summary: "Bed board with occupancy and stats",
        responses: {
          "200": okObject({ $ref: "#/components/schemas/BedBoardResponse" }, "The bed board snapshot."),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/audit": {
      get: {
        tags: ["operations"],
        summary: "List audit-log entries (most recent 2000)",
        responses: {
          "200": okObject(
            { type: "object", properties: { audit_log: { type: "array", items: { $ref: "#/components/schemas/AuditLogEntry" } } }, required: ["audit_log"] },
            "The audit-log entries.",
          ),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/notifications": {
      get: {
        tags: ["operations"],
        summary: "List notifications (most recent 2000)",
        responses: {
          "200": okObject(
            { type: "object", properties: { notifications: { type: "array", items: { $ref: "#/components/schemas/Notification" } } }, required: ["notifications"] },
            "The notification list.",
          ),
          ...authHeaderResponses,
        },
      },
    },
    "/api/public/bridge/health": {
      get: {
        tags: ["diagnostics"],
        summary: "Unauthenticated health/config check",
        security: [],
        responses: {
          "200": okObject({ $ref: "#/components/schemas/HealthResponse" }, "Health and serialized patient field keys. No patient data."),
        },
      },
    },
    "/api/public/bridge/verify-signature": {
      get: {
        tags: ["diagnostics"],
        summary: "HMAC self-test (self-signed round trip)",
        security: [],
        responses: {
          "200": okObject({ $ref: "#/components/schemas/VerifySignatureSelfTest" }, "Self-test passed."),
          "500": okObject({ $ref: "#/components/schemas/VerifySignatureSelfTest" }, "Self-test failed."),
          "503": okObject({ $ref: "#/components/schemas/Error" }, "Shared secret not configured."),
        },
      },
      post: {
        tags: ["diagnostics"],
        summary: "Validate a signature produced elsewhere",
        description: "Send the same signed headers a real bridge call uses; the body is verified verbatim.",
        responses: {
          "200": okObject({ $ref: "#/components/schemas/VerifySignatureResult" }, "The signature is valid."),
          "401": okObject({ $ref: "#/components/schemas/Error" }, "The signature is invalid."),
        },
      },
    },
    "/api/public/bridge/openapi": {
      get: {
        tags: ["diagnostics"],
        summary: "This OpenAPI 3.1 / JSON Schema document",
        security: [],
        responses: {
          "200": okObject({ type: "object", additionalProperties: true }, "The OpenAPI specification."),
        },
      },
    },
  },
} as const;
