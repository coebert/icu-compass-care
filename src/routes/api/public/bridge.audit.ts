import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { bridgeExport } from "@/lib/bridge-exports.server";

// Read-only bridge endpoint exposing this backend's audit log so the partner
// project can review and reconcile the synced audit trail. Append-only.
//
// audit_log diff snapshots can contain whole clinical payloads, so only typed
// entries leave: 'patients' entries for a still-shared bridge-unit patient, and
// 'referrals' entries for the referral such a patient came from. Checked in the
// same database statement that reads them; a matching UUID of another kind is
// never enough.
export const Route = createFileRoute("/api/public/bridge/audit")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/audit");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const out = await bridgeExport(supabaseAdmin, "bridge_export_audit");
        if (!out.ok) return json({ error: "Service unavailable" }, out.status);
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "audit",
          record_count: out.rows.length,
          actor: auth.actor,
        });
        return json({ audit_log: out.rows });
      },
    },
  },
});
