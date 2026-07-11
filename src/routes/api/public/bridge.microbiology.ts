import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorize, sharedPatientIds } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// Read-only bridge endpoint exposing this backend's microbiology results so the
// partner project can review and reconcile the synced set.
export const Route = createFileRoute("/api/public/bridge/microbiology")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        // Only expose microbiology for patients an admin has shared.
        const allowedIds = await sharedPatientIds(supabaseAdmin);
        if (allowedIds.length === 0) return json({ microbiology: [] });

        const { data, error } = await supabaseAdmin
          .from("microbiology_results")
          .select("*")
          .in("patient_id", allowedIds)
          .order("updated_at", { ascending: false })
          .limit(5000);
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        return json({ microbiology: data });
      },
    },
  },
});
