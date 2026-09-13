import { createFileRoute } from "@tanstack/react-router";
import {
  corsHeaders,
  json,
  authorizeBridge,
  logSync,
  sharedPatientIds,
  sharedReferralIds,
} from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// Read-only bridge endpoint exposing this backend's audit log so the partner
// project can review and reconcile the synced audit trail. Append-only.
//
// audit_log `diff` snapshots can contain whole clinical payloads, so the feed
// is gated to entries about records an administrator marked as shared with the
// partner (the patients themselves and the referrals that produced them).
export const Route = createFileRoute("/api/public/bridge/audit")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/audit");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const [patientIds, referralIds] = await Promise.all([
          sharedPatientIds(supabaseAdmin),
          sharedReferralIds(supabaseAdmin),
        ]);
        const allowedEntityIds = Array.from(new Set([...patientIds, ...referralIds]));
        if (allowedEntityIds.length === 0) {
          await logSync(supabaseAdmin, {
            direction: "pull",
            entity: "audit",
            record_count: 0,
            actor: auth.actor,
          });
          return json({ audit_log: [] });
        }

        const { data, error } = await supabaseAdmin
          .from("audit_log")
          .select("*")
          .in("entity_id", allowedEntityIds)
          .order("created_at", { ascending: false })
          .limit(2000);
        if (error)
          return (
            console.error("[bridge]", error), json({ error: "Internal server error" }, 500)
          );
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "audit",
          record_count: data?.length ?? 0,
          actor: auth.actor,
        });
        return json({ audit_log: data });
      },
    },
  },
});
