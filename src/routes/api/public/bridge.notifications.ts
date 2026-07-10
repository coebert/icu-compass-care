import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, json, authorize } from "@/lib/api-bridge.server";

// Read-only bridge endpoint exposing this backend's notifications so the
// partner project can review and reconcile the synced set. Guarded by the
// shared HMAC signature + a forwarded, role-checked actor.
export const Route = createFileRoute("/api/public/bridge/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("notifications")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(2000);
        if (error) return json({ error: error.message }, 500);
        return json({ notifications: data });
      },
    },
  },
});
