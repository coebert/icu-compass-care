import { createFileRoute } from "@tanstack/react-router";
import { decryptPatientRows } from "@/lib/patient-crypto.server";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { occupantView, requestLimit, type BridgePatient } from "@/lib/bridge-beds";

export const Route = createFileRoute("/api/public/bridge/bed_transfers_out")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/bed_transfers_out");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const { data, error } = await supabaseAdmin
          .from("patients")
          .select("*")
          .in("status", ["discharged", "died"])
          .eq("shared_with_partner", true)
          .order("updated_at", { ascending: false })
          .limit(requestLimit(request));
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));

        const bed_transfers_out = (
          decryptPatientRows(data as Array<Record<string, unknown>> | null) as unknown as BridgePatient[]
        ).map((p) => ({
          ...occupantView(p),
          discharge_date: p.discharge_date ?? null,
          discharge_destination: p.discharge_destination ?? null,
          date_of_death: p.date_of_death ?? null,
        }));

        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "beds",
          record_count: bed_transfers_out.length,
          actor: auth.actor,
        });

        return json({ bed_transfers_out, transfers: bed_transfers_out });
      },
    },
  },
});