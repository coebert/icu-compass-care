import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { BridgeHealthResult } from "@/lib/bridge-health.server";

export type { BridgeHealthResult, EndpointCheck } from "@/lib/bridge-health.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error("Failed to verify permissions");
  if (!data) throw new Error("Forbidden: admin only");
}

// One-click bridge health check (admin only): verifies the linked project's
// endpoints, HMAC signature auth, and a clean sample payload.
export const checkBridgeHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BridgeHealthResult> => {
    await assertAdmin(context);
    const { runBridgeHealth } = await import("@/lib/bridge-health.server");
    return runBridgeHealth();
  });
