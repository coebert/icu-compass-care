import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { BridgeHealthResult } from "@/lib/bridge-health.server";

export type { BridgeHealthResult, EndpointCheck } from "@/lib/bridge-health.server";

import { assertAdmin } from "@/lib/roles.server";

// One-click bridge health check (admin only): verifies the linked project's
// endpoints, HMAC signature auth, and a clean sample payload.
export const checkBridgeHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BridgeHealthResult> => {
    await assertAdmin(context);
    const { runBridgeHealth } = await import("@/lib/bridge-health.server");
    return runBridgeHealth();
  });
