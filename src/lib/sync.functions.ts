import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
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

export type SyncStatus = {
  lastSuccess: SyncEvent | null;
  lastError: SyncEvent | null;
  lastPush: SyncEvent | null;
  lastPull: SyncEvent | null;
  recent: SyncEvent[];
  config: SyncConfig;
};

// Returns the most recent bridge sync activity for the "Sync status" panel.
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SyncStatus> => {
    const { data, error } = await context.supabase
      .from("bridge_sync_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    const events = (data ?? []) as SyncEvent[];
    const intervalMinutes = Number(process.env.BRIDGE_SYNC_INTERVAL_MINUTES);
    return {
      lastSuccess: events.find((e) => e.status !== "error") ?? null,
      lastError: events.find((e) => e.status === "error") ?? null,
      lastPush: events.find((e) => e.direction === "push") ?? null,
      lastPull: events.find((e) => e.direction === "pull") ?? null,
      recent: events.slice(0, 8),
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
    const { data: role } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) throw new Error("Forbidden: admin only");

    const { runBridgeSync } = await import("@/lib/bridge-sync.server");
    return runBridgeSync();
  });
