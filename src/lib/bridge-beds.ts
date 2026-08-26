import { decryptPatientRows } from "@/lib/patient-crypto.server";
import { DEFAULT_BEDS, normalizeBed, type BedSlot } from "@/lib/icu-beds";

export type BridgePatient = Record<string, unknown> & {
  id: string;
  bed: string | null;
  status: string | null;
  location_type: string | null;
};

// Slim occupant projection — enough for a board view without dumping the whole
// clinical record over the bridge.
export function occupantView(p: BridgePatient) {
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
    // Ready-for-ward marker + when it was set, so the partner app can show
    // the same "waiting for ward bed" state and elapsed timer.
    wardable: p.wardable ?? null,
    wardable_at: p.wardable_at ?? null,
    updated_at: p.updated_at ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildBridgeBedBoard(supabaseAdmin: any) {
  // Active ICU patients are the only ones that occupy beds. We only expose
  // patients an admin has explicitly approved for cross-project sharing —
  // matching the governance gate used by every other bridge PHI feed.
  const { data, error } = await supabaseAdmin
    .from("patients")
    .select("*")
    .eq("location_type", "icu")
    .eq("shared_with_partner", true)
    .in("status", ["admitted", "referred"])
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const icu = decryptPatientRows(
    data as Array<Record<string, unknown>> | null,
  ) as unknown as BridgePatient[];

  // Load the admin-editable bed roster; fall back to defaults if empty.
  const { data: bedRows } = await supabaseAdmin
    .from("icu_beds")
    .select("label, is_side_room, position")
    .order("position", { ascending: true });
  const roster: BedSlot[] =
    bedRows && bedRows.length > 0
      ? bedRows.map((b: { label: string; is_side_room: boolean }) => ({
          label: b.label,
          is_side_room: b.is_side_room,
        }))
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

  return {
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
  };
}

export function requestLimit(request: Request, fallback = 500, max = 1000): number {
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}