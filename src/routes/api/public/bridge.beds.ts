import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, json, authorize, logSync } from "@/lib/api-bridge.server";
import { ICU_BEDS, SIDE_ROOMS, normalizeBed, isSideRoom, isKnownBed } from "@/lib/icu-beds";

/**
 * Read-only bridge endpoint exposing the Radnor Critical Care bed board to the
 * partner app: the fixed bed roster, per-bed occupancy, occupancy stats, and
 * any active ICU patients whose recorded bed does not match a known slot.
 *
 * Mirrors the in-app bed board (src/routes/_authenticated/patients.index.tsx)
 * so both surfaces agree on beds, occupancy, and side-room layout.
 */

type BridgePatient = Record<string, unknown> & {
  id: string;
  bed: string | null;
  status: string | null;
  location_type: string | null;
};

// Slim occupant projection — enough for a board view without dumping the whole
// clinical record over the bridge.
function occupantView(p: BridgePatient) {
  return {
    id: p.id,
    full_name: p.full_name ?? null,
    hospital_number: p.hospital_number ?? null,
    age: p.age ?? null,
    status: p.status ?? null,
    bed: p.bed ?? null,
    admission_date: p.admission_date ?? null,
    tep_in_place: p.tep_in_place ?? null,
    dnacpr_decision: p.dnacpr_decision ?? null,
    outstanding_tasks: p.outstanding_tasks ?? null,
    updated_at: p.updated_at ?? null,
  };
}

export const Route = createFileRoute("/api/public/bridge/beds")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Active ICU patients are the only ones that occupy beds.
        const { data, error } = await supabaseAdmin
          .from("patients")
          .select("*")
          .eq("location_type", "icu")
          .in("status", ["admitted", "referred"])
          .order("updated_at", { ascending: false });
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));

        const icu = (data ?? []) as BridgePatient[];

        // First active patient per bed wins (most recently updated, matching the UI).
        const occupantByBed = new Map<string, BridgePatient>();
        for (const p of icu) {
          const key = normalizeBed(p.bed);
          if (key && isKnownBed(key) && !occupantByBed.has(key)) occupantByBed.set(key, p);
        }

        const beds = ICU_BEDS.map((bed) => {
          const occupant = occupantByBed.get(normalizeBed(bed));
          return {
            bed,
            is_side_room: isSideRoom(bed),
            occupied: Boolean(occupant),
            occupant: occupant ? occupantView(occupant) : null,
          };
        });

        // Active ICU patients whose bed doesn't match a known slot (unassigned).
        const unassigned = icu
          .filter((p) => {
            const key = normalizeBed(p.bed);
            return !key || !isKnownBed(key);
          })
          .map(occupantView);

        const occupiedCount = beds.filter((b) => b.occupied).length;

        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "patients",
          record_count: occupiedCount + unassigned.length,
          actor: auth.actor,
        });

        return json({
          unit: "Radnor Critical Care Unit",
          side_rooms: SIDE_ROOMS,
          bed_board: beds,
          unassigned,
          stats: {
            total_beds: ICU_BEDS.length,
            occupied: occupiedCount,
            available: ICU_BEDS.length - occupiedCount,
            unassigned: unassigned.length,
          },
        });
      },
    },
  },
});
