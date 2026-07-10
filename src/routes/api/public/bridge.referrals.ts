import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, json, authorize } from "@/lib/api-bridge.server";

// Read-only bridge endpoint exposing this backend's referrals so the partner
// project can review and reconcile the synced set.
export const Route = createFileRoute("/api/public/bridge/referrals")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("referrals")
          .select("*")
          .order("updated_at", { ascending: false })
          .limit(2000);
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        return json({ referrals: data });
      },
    },
  },
});
