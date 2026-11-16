import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { bridgeExport } from "@/lib/bridge-exports.server";

// Read-only bridge endpoint exposing this backend's notifications so the
// partner project can review and reconcile the synced set. Notification
// messages carry clinical context, so only notifications about a referral
// whose bridge-unit patient is still shared leave this backend (checked in the
// same database statement that reads them). Notifications with no referral are
// internal to this backend.
export const Route = createFileRoute("/api/public/bridge/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/notifications");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const out = await bridgeExport(supabaseAdmin, "bridge_export_notifications");
        if (!out.ok) return json({ error: "Service unavailable" }, out.status);
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "notifications",
          record_count: out.rows.length,
          actor: auth.actor,
        });
        return json({ notifications: out.rows });
      },
    },
  },
});
