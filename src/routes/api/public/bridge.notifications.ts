import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorize } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// Read-only bridge endpoint exposing this backend's notifications so the
// partner project can review and reconcile the synced set. Guarded by the
// shared HMAC signature + a forwarded, role-checked actor.
export const Route = createFileRoute("/api/public/bridge/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const { data, error } = await supabaseAdmin
          .from("notifications")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(2000);
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        return json({ notifications: data });
      },
    },
  },
});
