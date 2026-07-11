import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";

export type BridgeSecurityAlert = {
  id: string;
  event_type: string;
  alert_key: string;
  event_count: number;
  window_minutes: number;
  threshold: number;
  status: "open" | "acknowledged" | "resolved";
  first_seen: string;
  last_seen: string;
  sample_detail: string | null;
  sample_ip: string | null;
  sample_actor_email: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type BridgeSecurityEvent = {
  id: string;
  event_type: string;
  endpoint: string | null;
  method: string | null;
  ip: string | null;
  actor_role: string | null;
  actor_email: string | null;
  detail: string | null;
  created_at: string;
};

export type BridgeSecurityOverview = {
  isAdmin: boolean;
  openCount: number;
  alerts: BridgeSecurityAlert[];
  recentEvents: BridgeSecurityEvent[];
};

async function assertAdmin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return Boolean(data);
}

// Open + recent bridge security alerts and the latest raw events (admin only).
export const getBridgeSecurityOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BridgeSecurityOverview> => {
    const isAdmin = await assertAdmin(context.supabase, context.userId);
    if (!isAdmin) {
      return { isAdmin: false, openCount: 0, alerts: [], recentEvents: [] };
    }

    const [alertsRes, eventsRes] = await Promise.all([
      context.supabase
        .from("bridge_security_alerts")
        .select("*")
        .order("status", { ascending: true })
        .order("last_seen", { ascending: false })
        .limit(50),
      context.supabase
        .from("bridge_security_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(30),
    ]);

    if (alertsRes.error) throw safeDbError(alertsRes.error, "load security alerts");
    if (eventsRes.error) throw safeDbError(eventsRes.error, "load security events");

    const alerts = (alertsRes.data ?? []) as BridgeSecurityAlert[];
    return {
      isAdmin: true,
      openCount: alerts.filter((a) => a.status === "open").length,
      alerts,
      recentEvents: (eventsRes.data ?? []) as BridgeSecurityEvent[],
    };
  });

// Mark a bridge security alert as acknowledged or resolved (admin only).
export const updateBridgeSecurityAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; status: "acknowledged" | "resolved"; note?: string }) => {
    if (!input?.id) throw new Error("Alert id is required");
    if (input.status !== "acknowledged" && input.status !== "resolved") {
      throw new Error("Invalid status");
    }
    return {
      id: String(input.id),
      status: input.status,
      note: input.note ? String(input.note).slice(0, 1000) : undefined,
    };
  })
  .handler(async ({ context, data }): Promise<BridgeSecurityAlert> => {
    const isAdmin = await assertAdmin(context.supabase, context.userId);
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: updated, error } = await context.supabase
      .from("bridge_security_alerts")
      .update({
        status: data.status,
        acknowledged_by: context.userId,
        acknowledged_at: new Date().toISOString(),
        ...(data.note !== undefined ? { note: data.note } : {}),
      })
      .eq("id", data.id)
      .select()
      .maybeSingle();

    if (error) throw safeDbError(error, "update security alert");
    if (!updated) throw new Error("Alert not found");
    return updated as BridgeSecurityAlert;
  });
