import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json, authorizeBridge, logSync } from "@/lib/api-bridge.server";
import { DEFAULT_BEDS, normalizeBed, type BedSlot } from "@/lib/icu-beds";
import { getAdmin } from "@/lib/admin-db.server";

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
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/beds");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();

        // Active ICU patients are the only ones that occupy beds.
        const { data, error } = await supabaseAdmin
          .from("patients")
          .select("*")
          .eq("location_type", "icu")
          .in("status", ["admitted", "referred"])
          .order("updated_at", { ascending: false });
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));

        const icu = (data ?? []) as BridgePatient[];

        // Load the admin-editable bed roster; fall back to defaults if empty.
        const { data: bedRows } = await supabaseAdmin
          .from("icu_beds")
          .select("label, is_side_room, position")
          .order("position", { ascending: true });
        const roster: BedSlot[] =
          bedRows && bedRows.length > 0
            ? bedRows.map((b) => ({ label: b.label, is_side_room: b.is_side_room }))
            : DEFAULT_BEDS;
        const rosterKeys = new Set(roster.map((b) => normalizeBed(b.label)));
        const isKnown = (bed: unknown) => rosterKeys.has(normalizeBed(bed));

        // First active patient per bed wins (most recently updated, matching the UI).
        const occupantByBed = new Map<string, BridgePatient>();
        for (const p of icu) {
          const key = normalizeBed(p.bed);
          if (key && isKnown(key) && !occupantByBed.has(key)) occupantByBed.set(key, p);
        }

        const beds = roster.map((slot) => {
          const occupant = occupantByBed.get(normalizeBed(slot.label));
          return {
            bed: slot.label,
            is_side_room: slot.is_side_room,
            occupied: Boolean(occupant),
            occupant: occupant ? occupantView(occupant) : null,
          };
        });

        // Active ICU patients whose bed doesn't match a known slot (unassigned).
        const unassigned = icu
          .filter((p) => {
            const key = normalizeBed(p.bed);
            return !key || !isKnown(key);
          })
          .map(occupantView);

        const occupiedCount = beds.filter((b) => b.occupied).length;

        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "beds",
          record_count: occupiedCount + unassigned.length,
          actor: auth.actor,
        });

        return json({
          unit: "Radnor Critical Care Unit",
          side_rooms: roster.filter((b) => b.is_side_room).map((b) => b.label),
          bed_board: beds,
          unassigned,
          stats: {
            total_beds: roster.length,
            occupied: occupiedCount,
            available: roster.length - occupiedCount,
            unassigned: unassigned.length,
          },
        });
      },
    },
  },
});
