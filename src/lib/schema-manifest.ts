// Client-safe declaration of the database schema this app depends on.
// The startup validator (schema-validation.server.ts) probes the live database
// against this manifest and fails fast when a table or column is missing —
// e.g. after pointing the app at a backend that was never fully migrated.
//
// Keep this list to columns the app actually reads/writes. It does not need to
// be exhaustive; it exists to catch a divergent or half-migrated schema early
// with a clear, actionable error rather than a confusing runtime 400 later.

export type TableManifest = {
  table: string;
  columns: string[];
};

export const REQUIRED_SCHEMA: TableManifest[] = [
  {
    table: "profiles",
    columns: ["id", "display_name", "full_name", "created_at", "updated_at"],
  },
  {
    table: "user_roles",
    columns: ["id", "user_id", "role", "created_at"],
  },
  {
    table: "patients",
    columns: [
      "id",
      "full_name",
      "age",
      "status",
      "location_type",
      "ward",
      "bed",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "investigations",
    columns: ["id", "patient_id", "category", "findings", "created_at", "updated_at"],
  },
  {
    table: "microbiology_results",
    columns: ["id", "patient_id", "specimen_type", "findings", "result_at", "created_at", "updated_at"],
  },
  {
    table: "referrals",
    columns: [
      "id",
      "status",
      "referring_specialty",
      "referral_received_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "postop_bookings",
    columns: ["id", "booking_status", "surgical_specialty", "created_at", "updated_at"],
  },
  {
    table: "icnarc_targets",
    columns: [
      "id",
      "decision_to_arrival_target_min",
      "time_to_seen_target_min",
      "updated_at",
    ],
  },
  {
    table: "notifications",
    columns: ["id", "user_id", "kind", "message", "read_at", "created_at"],
  },
  {
    table: "notification_deliveries",
    columns: [
      "id",
      "recipient_id",
      "kind",
      "channel",
      "status",
      "generated_at",
    ],
  },
  {
    table: "audit_log",
    columns: ["id", "action", "entity", "entity_id", "diff", "created_at"],
  },
  {
    table: "record_audit",
    columns: [
      "id",
      "entity",
      "record_id",
      "action",
      "source",
      "changed_fields",
      "created_at",
    ],
  },
  {
    table: "bridge_sync_events",
    columns: ["id", "direction", "entity", "record_count", "created_at"],
  },
];
