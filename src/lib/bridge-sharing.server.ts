// Partner-sharing gate for bridge writes. Every read used for a conflict
// answer and every mutation is filtered on shared_with_partner = true IN THE
// SAME STATEMENT, so revoking sharing between the check and the write can't
// let the write (or a clinical payload) through.

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

const GOVERNANCE_COLUMNS = [
  "shared_with_partner",
  "shared_with_partner_at",
  "shared_with_partner_by",
] as const;
// The partner may never move a record between units or change sharing.
const PROTECTED_WRITE_COLUMNS = [...GOVERNANCE_COLUMNS, "unit_id", "id"] as const;

export function stripSharingFlags<T extends Row>(row: T): T {
  const out = { ...row };
  for (const k of GOVERNANCE_COLUMNS) delete out[k];
  return out;
}

export type BridgeUpdateOutcome =
  | { kind: "updated"; before: Row; after: Row }
  | { kind: "conflict"; current: Row }
  | { kind: "not_found" }
  | { kind: "error"; error: unknown };

async function readShared(admin: AdminClient, id: string) {
  return admin
    .from("patients")
    .select("*")
    .eq("id", id)
    .eq("shared_with_partner", true)
    .maybeSingle();
}

export async function bridgeUpdateSharedPatient(
  admin: AdminClient,
  args: { id: string; expectedUpdatedAt?: string; payload: Row },
): Promise<BridgeUpdateOutcome> {
  const payload: Row = { ...args.payload };
  for (const k of PROTECTED_WRITE_COLUMNS) delete payload[k];

  const { data: current, error: readErr } = await readShared(admin, args.id);
  if (readErr) return { kind: "error", error: readErr };
  if (!current) return { kind: "not_found" };
  if (args.expectedUpdatedAt && current.updated_at !== args.expectedUpdatedAt) {
    return { kind: "conflict", current };
  }

  // Compare-and-set: still shared, same unit AND unchanged since we read it.
  const { data: updated, error: upErr } = await admin
    .from("patients")
    .update(payload as never)
    .eq("id", args.id)
    .eq("shared_with_partner", true)
    .eq("unit_id", current.unit_id)
    .eq("updated_at", current.updated_at)
    .select()
    .maybeSingle();
  if (upErr) return { kind: "error", error: upErr };
  if (updated) return { kind: "updated", before: current, after: updated };

  // Lost the race: re-read under the sharing filter. Revoked -> not found.
  const { data: fresh, error: freshErr } = await readShared(admin, args.id);
  if (freshErr) return { kind: "error", error: freshErr };
  if (!fresh) return { kind: "not_found" };
  return { kind: "conflict", current: fresh };
}

/** Investigations may only be added to shared patients (atomic in SQL). */
export async function bridgeInsertInvestigation(
  admin: AdminClient,
  rec: { patient_id: string; category: string; findings: string; result_at?: string | null },
): Promise<
  { kind: "created"; row: Row } | { kind: "not_found" } | { kind: "error"; error: unknown }
> {
  const { data, error } = await admin.rpc("bridge_insert_investigation", {
    _patient_id: rec.patient_id,
    _category: rec.category,
    _findings: rec.findings,
    _result_at: rec.result_at || new Date().toISOString(),
  });
  if (error) return { kind: "error", error };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { kind: "not_found" };
  return { kind: "created", row };
}
