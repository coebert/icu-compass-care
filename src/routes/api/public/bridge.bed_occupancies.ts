import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { buildBridgeBedBoard } from "@/lib/bridge-beds";

export const Route = createFileRoute("/api/public/bridge/bed_occupancies")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/bed_occupancies");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        let board;
        try {
          board = await buildBridgeBedBoard(supabaseAdmin);
        } catch (error) {
          return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        }

        const bed_occupancies = board.bed_board.map((slot) => ({
          bed: slot.bed,
          is_side_room: slot.is_side_room,
          occupied: slot.occupied,
          patient: slot.occupant,
          occupant: slot.occupant,
        }));

        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "beds",
          record_count: bed_occupancies.filter((b) => b.occupied).length,
          actor: auth.actor,
        });

        return json({ bed_occupancies, occupancies: bed_occupancies, stats: board.stats });
      },
    },
  },
});