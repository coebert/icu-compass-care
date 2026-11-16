import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { bridgeExport } from "@/lib/bridge-exports.server";

// Read-only bridge endpoint exposing this backend's referrals so the partner
// project can review and reconcile the synced set. Only referrals that produced
// a patient in the bridge unit who is still shared with the partner, checked in
// the same database statement that reads them.
export const Route = createFileRoute("/api/public/bridge/referrals")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/referrals");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const out = await bridgeExport(supabaseAdmin, "bridge_export_referrals");
        if (!out.ok) return json({ error: "Service unavailable" }, out.status);
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "referrals",
          record_count: out.rows.length,
          actor: auth.actor,
        });
        return json({ referrals: out.rows });
      },
    },
  },
});
