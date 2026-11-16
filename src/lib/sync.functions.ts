import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTrustAdmin, loadActor } from "@/lib/roles.server";
import type { SyncRunResult } from "@/lib/bridge-sync.server";
import { readSyncStatus } from "@/lib/sync-status.server";
import type { ResourceEvidence } from "@/lib/sync-status";

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
