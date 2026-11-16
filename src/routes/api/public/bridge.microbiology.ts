import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { bridgeExport } from "@/lib/bridge-exports.server";

// Read-only bridge endpoint exposing this backend's microbiology results so the
// partner project can review and reconcile the synced set. Only results whose
// patient is in the bridge unit and still shared, checked in the same database
// statement that reads them.
export const Route = createFileRoute("/api/public/bridge/microbiology")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/microbiology");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const out = await bridgeExport(supabaseAdmin, "bridge_export_microbiology");
        if (!out.ok) return json({ error: "Service unavailable" }, out.status);
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "microbiology",
          record_count: out.rows.length,
          actor: auth.actor,
        });
        return json({ microbiology: out.rows });
      },
    },
  },
});
