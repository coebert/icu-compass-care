// Server-only import of validated sync v1 records into this backend.
//
// Ownership rules (agreed with Critical Care Connect):
//  - Referrals are owned by CCC. Only the allowlisted fields are copied, each
//    write is a compare-and-set on the local revision, an equal/older source
//    revision is a no-op and a locally newer copy is never overwritten. The
//    source updated_at is kept as the revision (see the staged SQL helper).
//    Tombstones set deleted_at so the record leaves the picker; nothing is
//    hard-deleted.
//  - Investigation / microbiology results may only ADD new ids, and only for
//    a patient that already exists here, is in the bridge unit and is still
//    shared — checked inside the same database statement as the insert.
//    Identical existing content is a no-op; anything divergent is a conflict
//    for a person to resolve, never an overwrite.
// The database helpers are staged with the bed-integrity migration; until it
// is applied, imports report "import_unavailable" instead of writing unsafely.
import {
  mapReferral,
  mapResult,
  sameResult,
  tsKey,
  type ImportedResult,
  type ResultKind,
} from "@/lib/bridge-contract";
import { writeAudit, type AuditActor } from "@/lib/audit";
import type { SyncErrorCode } from "@/lib/sync-status";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export class ImportStepError extends Error {
  constructor(readonly code: SyncErrorCode) {
    super(code);
    this.name = "ImportStepError";
  }
}

export type ImportCounts = {
  applied: number;
  /** Same or older revision / identical content: nothing to do. */
  skipped: number;
  /** Writes the database refused. */
  failed: number;
  /** Divergent or concurrently changed local copy: left untouched. */
  conflicts: number;
  /** Results whose patient isn't present + shared in the bridge unit. */
  unlinked: number;
};
const zero = (): ImportCounts => ({ applied: 0, skipped: 0, failed: 0, conflicts: 0, unlinked: 0 });

export function countsCode(c: ImportCounts): SyncErrorCode | undefined {
  if (c.failed > 0) return "partial_write_failure";
  if (c.conflicts > 0) return "record_conflict";
  if (c.unlinked > 0) return "unlinked_records";
  return undefined;
}

const READ_CHUNK = 200;

async function readLocal(
  admin: Admin,
  table: string,
  ids: string[],
  columns: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .in("id", ids.slice(i, i + READ_CHUNK));
    if (error || !Array.isArray(data)) throw new ImportStepError("local_read_failed");
    for (const r of data as Record<string, unknown>[]) out.set(String(r.id).toLowerCase(), r);
  }
  return out;
}

// The staged helper isn't in the database yet (function not found).
const helperMissing = (err: { code?: string } | null | undefined) =>
  err?.code === "PGRST202" || err?.code === "42883";

export async function importReferrals(
  admin: Admin,
  raw: Record<string, unknown>[],
  actor: AuditActor,
): Promise<ImportCounts> {
  const rows = raw.map(mapReferral); // all-or-nothing validation before writes
  const counts = zero();
  if (rows.length === 0) return counts;
  const local = await readLocal(admin, "referrals", rows.map((r) => r.id), "id, updated_at");

  for (const row of rows) {
    const mine = local.get(row.id);
    let expected: string | null = null;
    if (!mine) {
      // Nothing to remove for a tombstone we never held.
      if (row.deleted_at !== null) {
        counts.skipped++;
        continue;
      }
    } else {
      const localKey = tsKey(mine.updated_at);
      if (localKey === null) {
        counts.failed++;
        continue;
      }
      // Equal or older source revision, or a locally newer edit: no-op.
      if ((tsKey(row.updated_at) as bigint) <= localKey) {
        counts.skipped++;
        continue;
      }
      expected = mine.updated_at as string;
    }
    const { data, error } = await admin.rpc("bridge_import_referral", {
      _rec: row,
      _expected_updated_at: expected,
    });
    if (error) {
      if (helperMissing(error)) throw new ImportStepError("import_unavailable");
      counts.failed++;
      continue;
    }
    if (data === "inserted" || data === "updated") {
      counts.applied++;
      await writeAudit(admin, {
        entity: "referrals",
        recordId: row.id,
        action: data === "inserted" ? "insert" : "update",
        source: "bridge",
        actor,
        before: mine ? { id: row.id, updated_at: mine.updated_at } : null,
        after: row,
      });
    } else if (data === "unchanged") counts.skipped++;
    else if (data === "conflict") counts.conflicts++;
    else counts.failed++;
  }
  return counts;
}

const RESULT_TABLE: Record<ResultKind, { table: string; typeCol: string; entity: "investigations" | "microbiology" }> = {
  investigations: { table: "investigations", typeCol: "category", entity: "investigations" },
  microbiology: { table: "microbiology_results", typeCol: "specimen_type", entity: "microbiology" },
};

export async function importResults(
  admin: Admin,
  kind: ResultKind,
  raw: Record<string, unknown>[],
  unitId: string,
  actor: AuditActor,
): Promise<ImportCounts> {
  const rows: ImportedResult[] = raw.map((r) => mapResult(kind, r));
  const counts = zero();
  if (rows.length === 0) return counts;
  const spec = RESULT_TABLE[kind];
  const local = await readLocal(
    admin,
    spec.table,
    rows.map((r) => r.id),
    `id, patient_id, ${spec.typeCol}, findings, result_at`,
  );

  for (const row of rows) {
    const mine = local.get(row.id);
    if (mine) {
      const same =
        !row.deleted &&
        sameResult(row, {
          patient_id: String(mine.patient_id),
          type: String(mine[spec.typeCol]),
          findings: String(mine.findings),
          result_at: String(mine.result_at),
        });
      if (same) counts.skipped++;
      else counts.conflicts++;
      continue;
    }
    if (row.deleted) {
      counts.skipped++;
      continue;
    }
    const { data, error } = await admin.rpc("bridge_import_result", {
      _kind: kind,
      _rec: {
        id: row.id,
        patient_id: row.patient_id,
        type: row.type,
        findings: row.findings,
        result_at: row.result_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      _unit_id: unitId,
    });
    if (error) {
      if (helperMissing(error)) throw new ImportStepError("import_unavailable");
      counts.failed++;
      continue;
    }
    if (data === "inserted") {
      counts.applied++;
      await writeAudit(admin, {
        entity: spec.entity,
        recordId: row.id,
        action: "insert",
        source: "bridge",
        actor,
        after: {
          id: row.id,
          patient_id: row.patient_id,
          [spec.typeCol]: row.type,
          findings: row.findings,
          result_at: row.result_at,
        },
      });
    } else if (data === "identical") counts.skipped++;
    else if (data === "conflict") counts.conflicts++;
    else if (data === "parent_unavailable") counts.unlinked++;
    else counts.failed++;
  }
  return counts;
}
