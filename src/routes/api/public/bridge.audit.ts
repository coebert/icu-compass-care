import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, json, authorize } from "@/lib/api-bridge.server";

// Read-only bridge endpoint exposing this backend's audit log so the partner
// project can review and reconcile the synced audit trail. Append-only.
export const Route = createFileRoute("/api/public/bridge/audit")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(2000);
        if (error) return json({ error: error.message }, 500);
        return json({ audit_log: data });
      },
    },
  },
});
