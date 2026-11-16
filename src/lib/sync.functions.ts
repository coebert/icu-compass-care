import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTrustAdmin, loadActor } from "@/lib/roles.server";
import type { SyncRunResult } from "@/lib/bridge-sync.server";
import {
  INBOUND_SYNC_ACTOR_ROLE,
  SYNC_RESOURCES,
  safeSyncErrorCode,
  type ResourceEvidence,
  type SyncResource,
} from "@/lib/sync-status";

export type SyncStatus =
  // Sync events are readable only by Trust administrators and auditors (RLS);
  // anyone else gets no panel rather than a misleading "never synced".
  | { access: "restricted" }
  | {
      access: "granted";
      checkedAt: string;
      /** A stream with no successful pull for longer than this is "delayed". */
      delayedAfterMinutes: number;
      resources: ResourceEvidence[];
      /** Only Trust administrators may start a manual sync. */
      canRetry: boolean;
    };

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

/** Pure core of getSyncStatus, exported for tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readSyncStatus(supabase: any, actor: { isTrustAdmin: boolean; isAuditor: boolean }) {
  if (!actor.isTrustAdmin && !actor.isAuditor) return { access: "restricted" } as const;
  const resources = await Promise.all(SYNC_RESOURCES.map((e) => evidenceFor(supabase, e)));
  return {
    access: "granted" as const,
    checkedAt: new Date().toISOString(),
    delayedAfterMinutes: delayedAfterMinutes(),
    resources,
    canRetry: actor.isTrustAdmin,
  };
}

// Latest inbound pull attempt AND latest successful pull, per resource.
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncStatus> => {
    const actor = await loadActor(context);
    return readSyncStatus(context.supabase, actor);
  });

// Trigger a full bridge synchronization pass (Trust admin only).
export const runBridgeSyncFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncRunResult> => {
    await assertTrustAdmin(context);

    const { runBridgeSync } = await import("@/lib/bridge-sync.server");
    return runBridgeSync();
  });
