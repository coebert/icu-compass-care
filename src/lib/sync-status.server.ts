// Server-only reader for the sync status panel. Uses the caller's own client,
// so RLS on bridge_sync_events still decides what can be read.
import {
  INBOUND_SYNC_ACTOR_ROLE,
  SYNC_RESOURCES,
  isSourceOwned,
  safeSyncErrorCode,
  type ResourceEvidence,
  type SyncResource,
} from "@/lib/sync-status";
import type { SyncStatus } from "@/lib/sync.functions";

// Deliberately excludes actor_email/actor_role; error_message is mapped to a
// safe code below and the raw text never leaves the server.
const EVIDENCE_COLUMNS = "status, record_count, error_message, created_at";

type EventRow = {
  status: string;
  record_count: number | null;
  error_message: string | null;
  created_at: string;
};

function delayedAfterMinutes(): number {
  const interval = Number(process.env.BRIDGE_SYNC_INTERVAL_MINUTES);
  return Number.isFinite(interval) && interval > 0 ? Math.max(interval * 3, 15) : 30;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evidenceFor(supabase: any, entity: SyncResource): Promise<ResourceEvidence> {
  // Recorded here, never imported: no events to read and nothing to alarm on.
  if (isSourceOwned(entity)) {
    return {
      entity,
      sourceOwned: true,
      unavailable: false,
      lastAttemptAt: null,
      lastAttemptOk: null,
      lastAttemptCode: null,
      lastSuccessAt: null,
      lastSuccessCount: null,
    };
  }
  // Only THIS app's inbound pull job — partner reads (also "pull") and partner
  // pushes are different streams and must not stand in for it.
  const base = () =>
    supabase
      .from("bridge_sync_events")
      .select(EVIDENCE_COLUMNS)
      .eq("direction", "pull")
      .eq("entity", entity)
      .eq("actor_role", INBOUND_SYNC_ACTOR_ROLE);
  const [attempt, success] = await Promise.all([
    base().order("created_at", { ascending: false }).limit(1).maybeSingle(),
    base().eq("status", "success").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (attempt.error || success.error) {
    return {
      entity,
      unavailable: true,
      lastAttemptAt: null,
      lastAttemptOk: null,
      lastAttemptCode: null,
      lastSuccessAt: null,
      lastSuccessCount: null,
    };
  }
  const a = attempt.data as EventRow | null;
  const s = success.data as EventRow | null;
  const attemptOk = a ? a.status === "success" : null;
  return {
    entity,
    unavailable: false,
    lastAttemptAt: a?.created_at ?? null,
    lastAttemptOk: attemptOk,
    lastAttemptCode: a && !attemptOk ? safeSyncErrorCode(a.error_message) : null,
    lastSuccessAt: s?.created_at ?? null,
    lastSuccessCount: s?.record_count ?? null,
  };
}

export type SyncStatusAccess = "oversight" | "scoped_clinical" | "restricted";

/**
 * Who may see the (safe, code-only) sync status:
 *  - Trust administrators and auditors: through their own client (RLS);
 *  - clinicians / unit administrators who are members of the bridge unit:
 *    the same safe fields, read by server code on their behalf. They get no
 *    table access, no actor columns and no raw errors, and cannot retry;
 *  - everyone else (incl. clinicians of other units): nothing.
 */
export function syncStatusAccess(
  actor: {
    isTrustAdmin: boolean;
    isAuditor: boolean;
    isClinician?: boolean;
    isUnitAdmin?: boolean;
    unitIds?: string[];
  },
  bridgeUnitId: string | null,
): SyncStatusAccess {
  if (actor.isTrustAdmin || actor.isAuditor) return "oversight";
  if (
    bridgeUnitId &&
    (actor.isClinician || actor.isUnitAdmin) &&
    (actor.unitIds ?? []).includes(bridgeUnitId)
  ) {
    return "scoped_clinical";
  }
  return "restricted";
}

export async function readSyncStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  actor: {
    isTrustAdmin: boolean;
    isAuditor: boolean;
    isClinician?: boolean;
    isUnitAdmin?: boolean;
    unitIds?: string[];
  },
  opts: {
    bridgeUnitId?: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serverClient?: () => Promise<any>;
  } = {},
): Promise<SyncStatus> {
  const access = syncStatusAccess(actor, opts.bridgeUnitId ?? null);
  if (access === "restricted") return { access: "restricted" };
  let reader = supabase;
  if (access === "scoped_clinical") {
    if (!opts.serverClient) return { access: "restricted" };
    reader = await opts.serverClient();
  }
  const resources = await Promise.all(SYNC_RESOURCES.map((e) => evidenceFor(reader, e)));
  return {
    access: "granted",
    checkedAt: new Date().toISOString(),
    delayedAfterMinutes: delayedAfterMinutes(),
    resources,
    canRetry: actor.isTrustAdmin,
  };
}
