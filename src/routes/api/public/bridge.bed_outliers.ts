import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { buildBridgeBedBoard, occupantView, requestLimit, type BridgePatient } from "@/lib/bridge-beds";

export const Route = createFileRoute("/api/public/bridge/bed_outliers")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/bed_outliers");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        let board;
        try {
          board = await buildBridgeBedBoard(supabaseAdmin);
        } catch (error) {
          return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        }

        const { data, error } = await supabaseAdmin
          .from("patients")
          .select("*")
          .eq("location_type", "outlier")
          .in("status", ["admitted", "referred"])
          .eq("shared_with_partner", true)
          .order("updated_at", { ascending: false })
          .limit(requestLimit(request));
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));

        const ward_outliers = ((data ?? []) as BridgePatient[]).map(occupantView);
        const bed_outliers = [...board.unassigned, ...ward_outliers];

        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "beds",
          record_count: bed_outliers.length,
          actor: auth.actor,
        });

        return json({ bed_outliers, unassigned: board.unassigned, ward_outliers });
      },
    },
  },
});