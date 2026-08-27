import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTrustAdmin } from "@/lib/roles.server";
import { safeDbError } from "@/lib/db-error";
import type { SyncRunResult } from "@/lib/bridge-sync.server";

export type SyncEvent = {
  id: string;
  direction: "push" | "pull";
  entity: "patients" | "investigations" | "referrals" | "microbiology";
  record_count: number;
  actor_role: string | null;
  actor_email: string | null;
  status: "success" | "error";
  error_message: string | null;
  created_at: string;
};

export type SyncConfig = {
  intervalMinutes: number;
};

export type EntitySyncSummary = {
  entity: "patients" | "investigations" | "referrals" | "microbiology";
  lastCount: number;
  lastSyncedAt: string | null;
};

export type SyncStatus = {
  lastSuccess: SyncEvent | null;
  lastError: SyncEvent | null;
  lastPush: SyncEvent | null;
  lastPull: SyncEvent | null;
  recent: SyncEvent[];
  byEntity: EntitySyncSummary[];
  config: SyncConfig;
};

const TRACKED_ENTITIES: EntitySyncSummary["entity"][] = [
  "patients",
  "investigations",
  "referrals",
  "microbiology",
];

// Returns the most recent bridge sync activity for the "Sync status" panel.
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncStatus> => {
    const { data, error } = await context.supabase
      .from("bridge_sync_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw safeDbError(error, "load sync status");

    const events = (data ?? []) as SyncEvent[];
    const intervalMinutes = Number(process.env.BRIDGE_SYNC_INTERVAL_MINUTES);

    // Per-entity summary: the most recent successful sync for each tracked
    // entity, so the panel can show referral / microbiology record counts
    // alongside patients and investigations.
    const byEntity: EntitySyncSummary[] = TRACKED_ENTITIES.map((entity) => {
      const last = events.find((e) => e.entity === entity && e.status !== "error");
      return {
        entity,
        lastCount: last?.record_count ?? 0,
        lastSyncedAt: last?.created_at ?? null,
      };
    });

    return {
      lastSuccess: events.find((e) => e.status !== "error") ?? null,
      lastError: events.find((e) => e.status === "error") ?? null,
      lastPush: events.find((e) => e.direction === "push") ?? null,
      lastPull: events.find((e) => e.direction === "pull") ?? null,
      recent: events.slice(0, 8),
      byEntity,
      config: {
        intervalMinutes:
          Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 15,
      },
    };
  });

// Trigger a full bridge synchronization pass (admin only).
export const runBridgeSyncFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncRunResult> => {
    await assertTrustAdmin(context);

    const { runBridgeSync } = await import("@/lib/bridge-sync.server");
    return runBridgeSync();
  });
