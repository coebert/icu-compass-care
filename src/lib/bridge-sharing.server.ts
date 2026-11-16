import { bedTakenInUnit, isBedUniqueViolation, occupiesBed } from "@/lib/bed-occupancy.server";
import { tsKey } from "@/lib/bridge-contract";

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
  /** Another active patient in this unit holds the requested bed. No identity is returned. */
  | { kind: "bed_conflict" }
  | { kind: "not_found" }
  | { kind: "error"; error: unknown };

// Every read the partner can learn from is limited to the bridge unit AND
// the sharing flag, so another unit's (or a withheld) patient is
// indistinguishable from one that doesn't exist.
async function readShared(admin: AdminClient, id: string, unitId: string) {
  return admin
    .from("patients")
    .select("*")
    .eq("id", id)
    .eq("unit_id", unitId)
    .eq("shared_with_partner", true)
    .maybeSingle();
}

export const isBedConflict = isBedUniqueViolation;

export async function bridgeUpdateSharedPatient(
  admin: AdminClient,
  /**
   * expectedUpdatedAt is REQUIRED: the exact revision the caller last saw.
   * There is no "blind" update and the server never substitutes its own
   * fresh revision for a missing one.
   */
  args: { id: string; unitId: string; expectedUpdatedAt: string; payload: Row },
): Promise<BridgeUpdateOutcome> {
  const payload: Row = { ...args.payload };
  for (const k of PROTECTED_WRITE_COLUMNS) delete payload[k];
  const expectedKey = tsKey(args.expectedUpdatedAt);
  if (expectedKey === null) return { kind: "error", error: new Error("expected revision required") };

  const { data: current, error: readErr } = await readShared(admin, args.id, args.unitId);
  if (readErr) return { kind: "error", error: readErr };
  if (!current) return { kind: "not_found" };
  // Microsecond-exact comparison, whatever the textual form.
  if (tsKey(current.updated_at) !== expectedKey) {
    return { kind: "conflict", current };
  }

  // Friendly early answer for a bed already held in this unit; the unique
  // active-bed index is the real guarantee once the staged migration is live.
  const touchesBed = ["bed", "location_type", "status"].some((k) => k in payload);
  if (touchesBed) {
    const merged = { ...current, ...payload };
    try {
      if (occupiesBed(merged) && (await bedTakenInUnit(admin, args.unitId, merged.bed as string, args.id))) {
        return { kind: "bed_conflict" };
      }
    } catch (e) {
      return { kind: "error", error: e };
    }
  }

  // Compare-and-set: still shared, still in the bridge unit AND unchanged
  // since we read it.
  const { data: updated, error: upErr } = await admin
    .from("patients")
    .update(payload as never)
    .eq("id", args.id)
    .eq("shared_with_partner", true)
    .eq("unit_id", args.unitId)
    .eq("updated_at", current.updated_at)
    .select()
    .maybeSingle();
  if (upErr) {
    if (isBedConflict(upErr)) return { kind: "bed_conflict" };
    return { kind: "error", error: upErr };
  }
  if (updated) return { kind: "updated", before: current, after: updated };

  // Lost the race: re-read under the same unit + sharing filter. Revoked or
  // moved out of the unit -> not found.
  const { data: fresh, error: freshErr } = await readShared(admin, args.id, args.unitId);
  if (freshErr) return { kind: "error", error: freshErr };
  if (!fresh) return { kind: "not_found" };
  return { kind: "conflict", current: fresh };
}

/** Investigations may only be added to shared patients in the bridge unit (atomic in SQL). */
export async function bridgeInsertInvestigation(
  admin: AdminClient,
  rec: { patient_id: string; category: string; findings: string; result_at?: string | null },
): Promise<
  | { kind: "created"; row: Row }
  | { kind: "not_found" }
  /** Bridge unit not resolvable (staged 0006 helper): refuse, never widen. */
  | { kind: "unavailable" }
  | { kind: "error"; error: unknown }
> {
  const { data, error } = await admin.rpc("bridge_insert_investigation", {
    _patient_id: rec.patient_id,
    _category: rec.category,
    _findings: rec.findings,
    _result_at: rec.result_at || new Date().toISOString(),
  });
  if (error) {
    if ((error as { code?: string }).code === "PT503") return { kind: "unavailable" };
    return { kind: "error", error };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { kind: "not_found" };
  return { kind: "created", row };
}
