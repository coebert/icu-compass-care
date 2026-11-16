import { encryptPatientPayload } from "@/lib/patient-crypto.server";
// Server-only orchestration for the bridge synchronization job.
//
// Strategy: PULL-based reconciliation. Each backend independently pulls the
// overlapping ICU data from the other and applies a last-write-wins merge
// keyed by `updated_at`. When both backends run this job on a schedule the
// result is eventual bidirectional convergence with no duplicate rows,
// because every record keeps its stable id across both databases.
import {
  fetchPartnerPatients,
  fetchPartnerInvestigations,
  fetchPartnerReferrals,
  fetchPartnerMicrobiology,
  bridgeSystemActor,
  BridgeFetchError,
} from "@/lib/bridge-client.server";
import { logSync, logSyncError, type BridgeActor } from "@/lib/api-bridge.server";
import { writeAudit } from "@/lib/audit";
import { getAdmin } from "@/lib/admin-db.server";
import { INBOUND_SYNC_ACTOR_ROLE, type SyncErrorCode, type SyncResource } from "@/lib/sync-status";

export type EntitySyncResult = {
  entity: SyncResource;
  fetched: number;
  applied: number;
  /** Unchanged: local copy is the same age or newer, so nothing was written. */
  skipped: number;
  /** Writes the database refused. Never folded into `skipped`. */
  failed: number;
  /** Safe code only — never raw partner/DB text. */
  error?: SyncErrorCode;
};

export type SyncRunResult = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  results: EntitySyncResult[];
};

// Events written by this job carry a role no bridge caller can present, so the
// status panel can tell our inbound pulls apart from partner reads/writes.
export const inboundSyncLogActor: BridgeActor = {
  id: bridgeSystemActor.id,
  email: bridgeSystemActor.email,
  role: INBOUND_SYNC_ACTOR_ROLE,
};

function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = a ? Date.parse(a) : 0;
  const tb = b ? Date.parse(b) : 0;
  return ta > tb;
}

class SyncStepError extends Error {
  constructor(readonly code: SyncErrorCode) {
    super(code);
  }
}

function errorCode(e: unknown): SyncErrorCode {
  if (e instanceof BridgeFetchError || e instanceof SyncStepError) return e.code;
  return "unexpected";
}

type Row = Record<string, unknown> & { id: string; updated_at?: string | null };

type ResourceSpec = {
  entity: SyncResource;
  table: string;
  fetchRemote: () => Promise<Row[]>;
  /** Turn a partner row into the payload to upsert locally. */
  prepare?: (remote: Row) => Record<string, unknown>;
};

// `shared_with_partner*` is a local governance decision — never let a pulled
// partner copy overwrite it.
function preparePatient(remote: Row): Record<string, unknown> {
  const { shared_with_partner, shared_with_partner_at, shared_with_partner_by, ...remoteSafe } =
    remote;
  void shared_with_partner;
  void shared_with_partner_at;
  void shared_with_partner_by;
  return encryptPatientPayload(remoteSafe);
}

export const SYNC_SPECS: ResourceSpec[] = [
  {
    entity: "patients",
    table: "patients",
    fetchRemote: fetchPartnerPatients as unknown as () => Promise<Row[]>,
    prepare: preparePatient,
  },
  {
    entity: "investigations",
    table: "investigations",
    fetchRemote: fetchPartnerInvestigations as unknown as () => Promise<Row[]>,
  },
  {
    entity: "referrals",
    table: "referrals",
    fetchRemote: fetchPartnerReferrals as unknown as () => Promise<Row[]>,
  },
  {
    entity: "microbiology",
    table: "microbiology_results",
    fetchRemote: fetchPartnerMicrobiology as unknown as () => Promise<Row[]>,
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncResource(admin: any, spec: ResourceSpec): Promise<EntitySyncResult> {
  const result: EntitySyncResult = {
    entity: spec.entity,
    fetched: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
  };
  try {
    const partner = await spec.fetchRemote();
    result.fetched = partner.length;

    if (partner.length > 0) {
      const { data: localRows, error: readErr } = await admin
        .from(spec.table)
        .select("*")
        .in(
          "id",
          partner.map((p) => p.id),
        );
      if (readErr || (localRows != null && !Array.isArray(localRows))) {
        throw new SyncStepError("local_read_failed");
      }
      const localById = new Map<string, Row>((localRows ?? []).map((r: Row) => [r.id, r]));

      for (const remote of partner) {
        const local = localById.get(remote.id);
        // Only apply when the record is new here, or the partner copy is strictly
        // newer than ours. Ties and older partner copies are left untouched, so
        // re-running a pass is idempotent.
        if (local && !newer(remote.updated_at, local.updated_at)) {
          result.skipped++;
          continue;
        }
        const payload = spec.prepare ? spec.prepare(remote) : remote;
        const { error: upErr } = await admin.from(spec.table).upsert(payload, { onConflict: "id" });
        if (upErr) {
          // e.g. a result whose patient has not synced yet. Counted as FAILED
          // (not unchanged) and retried on the next pass.
          result.failed++;
          continue;
        }
        await writeAudit(admin, {
          entity: spec.entity,
          recordId: remote.id,
          action: local ? "update" : "insert",
          source: "bridge",
          actor: bridgeSystemActor,
          before: local ?? null,
          after: remote,
        });
        result.applied++;
      }
    }

    if (result.failed > 0) {
      result.error = "partial_write_failure";
      await logSyncError(admin, {
        direction: "pull",
        entity: spec.entity,
        message: result.error,
        record_count: result.applied,
        actor: inboundSyncLogActor,
      });
    } else {
      // Also written for a valid empty pull: it is the heartbeat proving the
      // stream is alive and simply had nothing to send.
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

// Run one full synchronization pass across every overlapping entity.
// Patients sync first so dependent records (investigations/referrals/micro) resolve.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runBridgeSync(adminOverride?: any): Promise<SyncRunResult> {
  const startedAt = new Date().toISOString();
  const supabaseAdmin = adminOverride ?? (await getAdmin());
  const results: EntitySyncResult[] = [];
  for (const spec of SYNC_SPECS) results.push(await syncResource(supabaseAdmin, spec));
  return {
    ok: results.every((r) => !r.error && r.failed === 0),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
}
