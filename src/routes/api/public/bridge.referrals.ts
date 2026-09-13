import { createFileRoute } from "@tanstack/react-router";
import {
  corsHeaders,
  json,
  authorizeBridge,
  logSync,
  sharedReferralIds,
} from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// Read-only bridge endpoint exposing this backend's referrals so the partner
// project can review and reconcile the synced set.
//
// Gated by the same sharing consent as every other clinical feed: only
// referrals that produced a patient an administrator marked as shared with the
// partner ever leave this backend.
export const Route = createFileRoute("/api/public/bridge/referrals")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/referrals");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const allowedIds = await sharedReferralIds(supabaseAdmin);
        if (allowedIds.length === 0) {
          await logSync(supabaseAdmin, {
            direction: "pull",
            entity: "referrals",
            record_count: 0,
            actor: auth.actor,
          });
          return json({ referrals: [] });
        }

        const { data, error } = await supabaseAdmin
          .from("referrals")
          .select("*")
          .in("id", allowedIds)
          .order("updated_at", { ascending: false })
          .limit(2000);
        if (error)
          return (
            console.error("[bridge]", error), json({ error: "Internal server error" }, 500)
          );
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "referrals",
          record_count: data?.length ?? 0,
          actor: auth.actor,
        });
        return json({ referrals: data });
      },
    },
  },
});
