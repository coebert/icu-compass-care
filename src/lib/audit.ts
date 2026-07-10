// Client-safe audit helper. No server-only imports so it can be referenced
// from server-function modules that are part of the client module graph.
// It is only ever CALLED inside server handlers, with a Supabase client passed in.

export type AuditEntity = "patients" | "investigations";
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

type MinimalClient = {
  from: (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (values: any) => Promise<any>;
  };
};

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
