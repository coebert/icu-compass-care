import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTrustAdmin, loadActor } from "@/lib/roles.server";
import type { SyncRunResult } from "@/lib/bridge-sync.server";
import { readSyncStatus } from "@/lib/sync-status.server";
import { defaultUnitId } from "@/lib/scope.server";
import type { ResourceEvidence } from "@/lib/sync-status";

export type SyncStatus =
  // Trust administrators / auditors (RLS), or clinical members of the bridge
  // unit (safe fields via server code). Anyone else gets no panel rather than
  // a misleading "never synced".
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

// Latest inbound pull attempt AND latest successful pull, per resource.
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncStatus> => {
    const actor = await loadActor(context);
    let bridgeUnitId: string | null = null;
    try {
      bridgeUnitId = await defaultUnitId(context.supabase);
    } catch {
      bridgeUnitId = null; // fail closed: no clinical access to status
    }
    return readSyncStatus(context.supabase, actor, {
      bridgeUnitId,
      serverClient: async () => (await import("@/lib/admin-db.server")).getAdmin(),
    });
  });

// Trigger a full bridge synchronization pass (Trust admin only).
export const runBridgeSyncFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncRunResult> => {
    await assertTrustAdmin(context);

    const { runBridgeSync } = await import("@/lib/bridge-sync.server");
    return runBridgeSync();
  });
