import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// Read-only bridge endpoint exposing this backend's audit log so the partner
// project can review and reconcile the synced audit trail. Append-only.
export const Route = createFileRoute("/api/public/bridge/audit")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/audit");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const { data, error } = await supabaseAdmin
          .from("audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(2000);
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        await logSync(supabaseAdmin, { direction: "pull", entity: "audit", record_count: data?.length ?? 0, actor: auth.actor });
        return json({ audit_log: data });
      },
    },
  },
});
