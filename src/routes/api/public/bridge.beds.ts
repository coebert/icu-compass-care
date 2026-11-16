import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { bedBoardUnavailableResponse, buildBridgeBedBoard } from "@/lib/bridge-beds";

/**
 * Read-only bridge endpoint exposing the Radnor Critical Care bed board to the
 * partner app: the fixed bed roster, per-bed occupancy, occupancy stats, and
 * any active ICU patients whose recorded bed does not match a known slot.
 *
 * Mirrors the in-app bed board (src/routes/_authenticated/patients.index.tsx)
 * so both surfaces agree on beds, occupancy, and side-room layout.
 */

export const Route = createFileRoute("/api/public/bridge/beds")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/beds");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        let board;
        try {
          board = await buildBridgeBedBoard(supabaseAdmin);
        } catch (error) {
          // Fail closed: never claim capacity from a doubtful snapshot.
          return bedBoardUnavailableResponse(error);
        }

        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "beds",
          record_count: board.stats.occupied + board.stats.unassigned,
          actor: auth.actor,
        });

        return json(board);
      },
    },
  },
});
