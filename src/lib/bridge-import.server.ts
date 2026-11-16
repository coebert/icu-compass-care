// Server-only import of validated sync v1 records into this backend.
//
// Ownership rules (agreed with Critical Care Connect):
//  - Referrals are owned by CCC. The database helper keeps a protected
//    provenance record per imported referral (source revision + the local
//    revision our own write produced). A local row without that provenance
//    (a legacy copy, or one created here) is a conflict — never adopted or
//    overwritten. Later edits / tombstones apply only while the local row is
//    still exactly what we last imported. Same/older source revisions are
//    no-ops. Tombstones mark a trusted imported referral deleted; an unknown
//    tombstone does nothing. Content, provenance and audit commit together.
//  - Investigation / microbiology results may only ADD new ids, for a patient
//    that already exists here, is in the bridge unit and is still shared —
//    checked inside the same locked database statement as the insert (unit
//    resolved by the database, never passed in). Identical existing content
//    is a no-op; anything divergent is a conflict, never an overwrite.
// The database helpers are staged (0006); until applied, imports report
// "import_unavailable" instead of writing unsafely.
import {
  mapReferral,
  mapResult,
  referralImportPayload,
  type ImportedResult,
  type ResultKind,
} from "@/lib/bridge-contract";
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
  /** Same or older revision, identical content, or an unknown tombstone: nothing to do. */
  skipped: number;
  /** Writes the database refused. */
  failed: number;
  /** Local copy without import provenance, or changed here: left untouched. */
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

type DbErr = { code?: string } | null | undefined;
// The staged helper isn't in the database yet (function not found).
const helperMissing = (err: DbErr) => err?.code === "PGRST202" || err?.code === "42883";
const unitMissing = (err: DbErr) => err?.code === "PT503";

export const REFERRAL_OUTCOMES = {
  applied: ["inserted", "updated", "restored", "deleted"],
  skipped: ["unchanged", "unknown_tombstone"],
  conflicts: ["conflict"],
} as const;

export async function importReferrals(
  admin: Admin,
  raw: Record<string, unknown>[],
): Promise<ImportCounts> {
  const rows = raw.map(mapReferral); // all-or-nothing validation before any write
  const counts = zero();
  for (const row of rows) {
    const { data, error } = await admin.rpc("bridge_import_referral", {
      _rec: referralImportPayload(row),
    });
    if (error) {
      if (helperMissing(error)) throw new ImportStepError("import_unavailable");
      counts.failed++;
      continue;
    }
    if ((REFERRAL_OUTCOMES.applied as readonly unknown[]).includes(data)) counts.applied++;
    else if ((REFERRAL_OUTCOMES.skipped as readonly unknown[]).includes(data)) counts.skipped++;
    else if (data === "conflict") counts.conflicts++;
    else counts.failed++;
  }
  return counts;
}

const RESULT_TABLE: Record<ResultKind, { table: string }> = {
  investigations: { table: "investigations" },
  microbiology: { table: "microbiology_results" },
};

export async function importResults(
  admin: Admin,
  kind: ResultKind,
  raw: Record<string, unknown>[],
): Promise<ImportCounts> {
  const rows: ImportedResult[] = raw.map((r) => mapResult(kind, r)); // validate all first
  const counts = zero();

  // A deleted result can't be represented here: never inserted; a local copy
  // is flagged for a person rather than removed.
  const deletedIds = rows.filter((r) => r.deleted).map((r) => r.id);
  const localDeleted = new Set<string>();
  for (let i = 0; i < deletedIds.length; i += 200) {
    const { data, error } = await admin
      .from(RESULT_TABLE[kind].table)
      .select("id")
      .in("id", deletedIds.slice(i, i + 200));
    if (error || !Array.isArray(data)) throw new ImportStepError("local_read_failed");
    for (const r of data as { id: string }[]) localDeleted.add(String(r.id).toLowerCase());
  }

  for (const row of rows) {
    if (row.deleted) {
      if (localDeleted.has(row.id)) counts.conflicts++;
      else counts.skipped++;
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
    });
    if (error) {
      if (helperMissing(error)) throw new ImportStepError("import_unavailable");
      if (unitMissing(error)) throw new ImportStepError("bridge_unit_unavailable");
      counts.failed++;
      continue;
    }
    if (data === "inserted") counts.applied++;
    else if (data === "identical") counts.skipped++;
    else if (data === "conflict") counts.conflicts++;
    else if (data === "parent_unavailable") counts.unlinked++;
    else counts.failed++;
  }
  return counts;
}
