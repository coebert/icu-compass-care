// Server-only orchestration for the scheduled inbound bridge import.
//
// Patients are authoritative in THIS app: they are never bulk-imported from
// Critical Care Connect (clinician-initiated signed partial updates still
// arrive through POST /api/public/bridge/patients). Referrals, investigations
// and microbiology are pulled with the versioned sync v1 contract; every page
// is validated before anything is written, then the ownership rules in
// bridge-import.server.ts decide what may change.
import { fetchSyncV1, bridgeSystemActor, BridgeFetchError, type SyncV1Resource } from "@/lib/bridge-client.server";
import { ContractError } from "@/lib/bridge-contract";
import { logSync, logSyncError, type BridgeActor } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import {
  importReferrals,
  importResults,
  countsCode,
  ImportStepError,
  type ImportCounts,
} from "@/lib/bridge-import.server";
import {
  INBOUND_SYNC_ACTOR_ROLE,
  SOURCE_OWNED_RESOURCES,
  type SyncErrorCode,
  type SyncResource,
} from "@/lib/sync-status";

export type EntitySyncResult = {
  entity: SyncResource;
  fetched: number;
  applied: number;
  /** Unchanged: same/older revision or identical content; nothing written. */
  skipped: number;
  /** Writes the database refused. Never folded into `skipped`. */
  failed: number;
  /** Local copy differs or changed concurrently; left for a person. */
  conflicts: number;
  /** Results for patients not present + shared in the bridge unit. */
  unlinked: number;
  /** Safe code only — never raw partner/DB text. */
  error?: SyncErrorCode;
};

export type SyncRunResult = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  results: EntitySyncResult[];
  /** Streams recorded here and never imported (e.g. patients). */
  sourceOwned: SyncResource[];
};

// Events written by this job carry a role no bridge caller can present, so the
// status panel can tell our inbound pulls apart from partner reads/writes.
export const inboundSyncLogActor: BridgeActor = {
  id: bridgeSystemActor.id,
  email: bridgeSystemActor.email,
  role: INBOUND_SYNC_ACTOR_ROLE,
};

function errorCode(e: unknown): SyncErrorCode {
  if (e instanceof BridgeFetchError || e instanceof ContractError || e instanceof ImportStepError) {
    return e.code;
  }
  return "unexpected";
}

type ImportSpec = {
  entity: Exclude<SyncResource, "patients">;
  source: SyncV1Resource;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (admin: any, records: Record<string, unknown>[]) => Promise<ImportCounts>;
};

// The bridge unit is resolved by the database inside each import helper;
// nothing here chooses or passes a unit.
export const IMPORT_SPECS: ImportSpec[] = [
  { entity: "referrals", source: "referrals", apply: (admin, records) => importReferrals(admin, records) },
  {
    entity: "investigations",
    source: "investigations",
    apply: (admin, records) => importResults(admin, "investigations", records),
  },
  {
    entity: "microbiology",
    source: "microbiology",
    apply: (admin, records) => importResults(admin, "microbiology", records),
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncResource(admin: any, spec: ImportSpec): Promise<EntitySyncResult> {
  const result: EntitySyncResult = {
    entity: spec.entity,
    fetched: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    conflicts: 0,
    unlinked: 0,
  };
  try {
    const { records } = await fetchSyncV1(spec.source);
    result.fetched = records.length;
    const counts = await spec.apply(admin, records);
    Object.assign(result, counts);
    result.error = countsCode(counts);
    if (result.error) {
      await logSyncError(admin, {
        direction: "pull",
        entity: spec.entity,
        message: result.error,
        record_count: result.applied,
        actor: inboundSyncLogActor,
      });
    } else {
      // Also written for a valid empty pull: the heartbeat proving the stream
      // is alive and simply had nothing to send.
      await logSync(admin, {
        direction: "pull",
        entity: spec.entity,
        record_count: result.applied,
        actor: inboundSyncLogActor,
      });
    }
  } catch (e) {
    result.error = errorCode(e);
    console.error("[bridge-sync]", spec.entity, result.error);
    await logSyncError(admin, {
      direction: "pull",
      entity: spec.entity,
      message: result.error,
      record_count: result.applied,
      actor: inboundSyncLogActor,
    });
  }
  return result;
}

// One full import pass. Each stream is independent: a failure in one never
// stops or hides the others.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runBridgeSync(adminOverride?: any): Promise<SyncRunResult> {
  const startedAt = new Date().toISOString();
  const admin = adminOverride ?? (await getAdmin());
  const results: EntitySyncResult[] = [];
  for (const spec of IMPORT_SPECS) results.push(await syncResource(admin, spec));
  return {
    ok: results.every((r) => !r.error),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    sourceOwned: [...SOURCE_OWNED_RESOURCES],
  };
}
