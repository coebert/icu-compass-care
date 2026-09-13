import { createFileRoute } from "@tanstack/react-router";
import {
  corsHeaders,
  json,
  authorizeBridge,
  logSync,
  sharedReferralIds,
} from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// Read-only bridge endpoint exposing this backend's notifications so the
// partner project can review and reconcile the synced set. Guarded by the
// shared HMAC signature + a forwarded, role-checked actor.
//
// Notification messages carry clinical context, so the feed is gated to
// notifications about referrals whose patient an administrator marked as
// shared. Notifications with no referral are internal to this backend.
export const Route = createFileRoute("/api/public/bridge/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/notifications");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const allowedReferralIds = await sharedReferralIds(supabaseAdmin);
        if (allowedReferralIds.length === 0) {
          await logSync(supabaseAdmin, {
            direction: "pull",
            entity: "notifications",
            record_count: 0,
            actor: auth.actor,
          });
          return json({ notifications: [] });
        }

        const { data, error } = await supabaseAdmin
          .from("notifications")
          .select("*")
          .in("referral_id", allowedReferralIds)
          .order("created_at", { ascending: false })
          .limit(2000);
        if (error)
          return (
            console.error("[bridge]", error), json({ error: "Internal server error" }, 500)
          );
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "notifications",
          record_count: data?.length ?? 0,
          actor: auth.actor,
        });
        return json({ notifications: data });
      },
    },
  },
});
