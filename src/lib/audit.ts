// Client-safe audit helper. No server-only imports so it can be referenced
// from server-function modules that are part of the client module graph.
// It is only ever CALLED inside server handlers, with a Supabase client passed in.

export type AuditEntity = "patients" | "investigations" | "referrals";
export type AuditAction = "insert" | "update" | "delete";
export type AuditSource = "app" | "bridge";

export type AuditActor = {
  id?: string | null;
  role?: string | null;
  email?: string | null;
};

// Fields that never count as a meaningful change.
const IGNORED = new Set(["updated_at", "created_at", "updated_by", "created_by", "id"]);

export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) changed.push(k);
  }
  return changed;
}

// Accept any Supabase-like client (browser or admin); the shapes differ
// structurally but both support .from(table).insert(values).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MinimalClient = any;

export async function writeAudit(
  client: MinimalClient,
  params: {
    entity: AuditEntity;
    recordId: string;
    action: AuditAction;
    source: AuditSource;
    actor: AuditActor;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  const changed =
    params.action === "update" ? diffFields(params.before, params.after) : [];
  try {
    await client.from("record_audit").insert({
      entity: params.entity,
      record_id: params.recordId,
      action: params.action,
      source: params.source,
      actor_id: params.actor.id ?? null,
      actor_role: params.actor.role ?? null,
      actor_email: params.actor.email ?? null,
      changed_fields: changed,
      before: params.before ?? null,
      after: params.after ?? null,
    });
  } catch {
    // best-effort; auditing must never break the primary operation
  }
}

// Field-level auditing for a defined set of patient columns. Each changed field
// produces its own row capturing old/new value, the editing user, and a timestamp.
const TRACKED_PATIENT_FIELDS: { column: string; label: string }[] = [
  { column: "full_name", label: "initials" },
  { column: "age", label: "age" },
  { column: "hospital_number", label: "hospital_number" },
];

function toStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

export async function writePatientFieldChanges(
  client: MinimalClient,
  params: {
    patientId: string;
    before: Record<string, unknown> | null | undefined;
    after: Record<string, unknown> | null | undefined;
    actor: AuditActor;
  },
): Promise<void> {
  const { before, after } = params;
  if (!before || !after) return;
  const rows = TRACKED_PATIENT_FIELDS.flatMap(({ column, label }) => {
    const oldVal = toStr(before[column]);
    const newVal = toStr(after[column]);
    if (oldVal === newVal) return [];
    return [
      {
        patient_id: params.patientId,
        field_name: label,
        old_value: oldVal,
        new_value: newVal,
        changed_by: params.actor.id ?? null,
        changed_by_email: params.actor.email ?? null,
      },
    ];
  });
  if (rows.length === 0) return;
  try {
    await client.from("patient_field_changes").insert(rows);
  } catch {
    // best-effort; auditing must never break the primary operation
  }
}
