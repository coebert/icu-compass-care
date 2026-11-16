import { decryptPatientRows } from "@/lib/patient-crypto.server";
import { json } from "@/lib/api-bridge.server";
import { SEED_UNIT_CODE } from "@/lib/scope.server";
import { DEFAULT_BEDS, normalizeBed, type BedSlot } from "@/lib/icu-beds";

export type BridgePatient = Record<string, unknown> & {
  id: string;
  bed: string | null;
  status: string | null;
  location_type: string | null;
};

// Slim occupant projection — enough for a board view without dumping the whole
// clinical record over the bridge. Only ever built from rows that are still
// shared_with_partner=true (see buildBridgeBedBoard).
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

export type OccupantView = ReturnType<typeof occupantView>;

export type BridgeBedSlot = {
  bed: string;
  is_side_room: boolean;
  occupied: boolean;
  /** null when the bed is vacant OR occupied by a patient not shared with the partner. */
  occupant: OccupantView | null;
};

export type BridgeBedBoard = {
  unit: string;
  side_rooms: string[];
  bed_board: BridgeBedSlot[];
  /** Shared identities only. */
  unassigned: OccupantView[];
  stats: {
    total_beds: number;
    /** Every occupied slot, including slots held by withheld (not shared) patients. */
    occupied: number;
    /** Slots with no active ICU patient at all. */
    available: number;
    /** Every active ICU patient without a known slot, shared or not. */
    unassigned: number;
  };
  /** ISO-8601 instant the snapshot reads started. */
  generated_at: string;
};

/** Why the board could not be produced. Codes are safe to send to the partner. */
export type BedBoardFailure =
  | "unit_unavailable"
  | "roster_unavailable"
  | "roster_malformed"
  | "roster_duplicate_label"
  | "occupancy_unavailable"
  | "occupancy_malformed"
  | "occupancy_incomplete"
  | "ambiguous_assignment"
  | "identity_unavailable"
  | "identity_mismatch";

export class BedBoardUnavailableError extends Error {
  constructor(readonly reason: BedBoardFailure) {
    super(`Bed board unavailable: ${reason}`);
    this.name = "BedBoardUnavailableError";
  }
}

export const BED_BOARD_UNIT_LABEL = "Radnor Critical Care Unit";
const ACTIVE_STATUSES = ["admitted", "referred"] as const;
// Physical-occupancy facts: no names, numbers or clinical content.
export const OCCUPANCY_FACT_COLUMNS = "id, bed, shared_with_partner";
// A 12–60 bed unit never has this many active ICU rows; more means something is wrong.
const MAX_ACTIVE_ICU_ROWS = 500;

type Fact = { id: string; bed: string | null; shared: boolean; key: string };

function fail(reason: BedBoardFailure): never {
  throw new BedBoardUnavailableError(reason);
}

function parseRoster(rows: unknown): BedSlot[] {
  if (!Array.isArray(rows)) fail("roster_malformed");
  // An empty table is the never-configured state (saving requires >= 1 bed),
  // which the in-app board also shows as the default roster.
  if (rows.length === 0) return DEFAULT_BEDS;
  const seen = new Set<string>();
  return rows.map((r) => {
    const row = r as { label?: unknown; is_side_room?: unknown } | null;
    if (!row || typeof row.label !== "string" || typeof row.is_side_room !== "boolean") {
      fail("roster_malformed");
    }
    const key = normalizeBed(row.label);
    if (!key) fail("roster_malformed");
    if (seen.has(key)) fail("roster_duplicate_label");
    seen.add(key);
    return { label: row.label, is_side_room: row.is_side_room };
  });
}

function parseFacts(rows: unknown, count: unknown): Fact[] {
  if (!Array.isArray(rows)) fail("occupancy_malformed");
  if (typeof count !== "number" || count !== rows.length) fail("occupancy_incomplete");
  const ids = new Set<string>();
  return rows.map((r) => {
    const row = r as { id?: unknown; bed?: unknown; shared_with_partner?: unknown } | null;
    if (
      !row ||
      typeof row.id !== "string" ||
      row.id === "" ||
      !(row.bed === null || typeof row.bed === "string") ||
      typeof row.shared_with_partner !== "boolean"
    ) {
      fail("occupancy_malformed");
    }
    if (ids.has(row.id)) fail("occupancy_malformed");
    ids.add(row.id);
    return {
      id: row.id,
      bed: row.bed as string | null,
      shared: row.shared_with_partner,
      key: normalizeBed(row.bed),
    };
  });
}

const byUpdatedDesc = (a: BridgePatient, b: BridgePatient) =>
  String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));

/**
 * Partner bed board for the fixed Radnor unit.
 *
 * Two reads, kept separate on purpose:
 *  1. physical occupancy — every active ICU patient in the unit, minimal
 *     non-identifying columns only, so a withheld patient still holds a bed;
 *  2. shared identity — full rows (decrypted) ONLY for patients still
 *     shared_with_partner=true.
 * Any doubt (failed read, malformed row, duplicate label, two patients in one
 * bed, rows changing between the reads) throws BedBoardUnavailableError rather
 * than reporting capacity that may not exist.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildBridgeBedBoard(supabaseAdmin: any): Promise<BridgeBedBoard> {
  const generated_at = new Date().toISOString();

  const { data: unit, error: unitErr } = await supabaseAdmin
    .from("icu_units")
    .select("id")
    .eq("code", SEED_UNIT_CODE)
    .maybeSingle();
  if (unitErr || !unit || typeof unit.id !== "string") fail("unit_unavailable");
  const unitId: string = unit.id;

  const { data: bedRows, error: bedErr } = await supabaseAdmin
    .from("icu_beds")
    .select("label, is_side_room, position")
    .order("position", { ascending: true });
  if (bedErr) fail("roster_unavailable");
  const roster = parseRoster(bedRows);
  const rosterKeys = new Set(roster.map((b) => normalizeBed(b.label)));

  const {
    data: factRows,
    error: factErr,
    count,
  } = await supabaseAdmin
    .from("patients")
    .select(OCCUPANCY_FACT_COLUMNS, { count: "exact" })
    .eq("unit_id", unitId)
    .eq("location_type", "icu")
    .in("status", ACTIVE_STATUSES)
    .order("id", { ascending: true })
    .range(0, MAX_ACTIVE_ICU_ROWS - 1);
  if (factErr) fail("occupancy_unavailable");
  const facts = parseFacts(factRows, count);

  const factsBySlot = new Map<string, Fact>();
  const unassignedFacts: Fact[] = [];
  for (const f of facts) {
    if (f.key && rosterKeys.has(f.key)) {
      if (factsBySlot.has(f.key)) fail("ambiguous_assignment");
      factsBySlot.set(f.key, f);
    } else {
      unassignedFacts.push(f);
    }
  }

  // Identity projection for shared patients only.
  const identityById = new Map<string, BridgePatient>();
  if (facts.some((f) => f.shared)) {
    const { data: idRows, error: idErr } = await supabaseAdmin
      .from("patients")
      .select("*")
      .eq("unit_id", unitId)
      .eq("location_type", "icu")
      .in("status", ACTIVE_STATUSES)
      .eq("shared_with_partner", true);
    if (idErr) fail("identity_unavailable");
    if (!Array.isArray(idRows)) fail("identity_unavailable");
    let rows: BridgePatient[];
    try {
      rows = decryptPatientRows(idRows as Array<Record<string, unknown>>) as unknown as BridgePatient[];
    } catch {
      fail("identity_unavailable");
    }
    const factById = new Map(facts.map((f) => [f.id, f]));
    for (const p of rows) {
      const fact = factById.get(p.id);
      // Admitted or moved between the two reads: refuse a mixed snapshot.
      if (!fact || normalizeBed(p.bed) !== fact.key) fail("identity_mismatch");
      identityById.set(p.id, p);
    }
  }
  // A shared fact with no identity row was un-shared between the reads; it is
  // still counted as occupying its bed, just without details.
  const identityFor = (f: Fact | undefined) =>
    f && f.shared ? (identityById.get(f.id) ?? null) : null;

  const bed_board: BridgeBedSlot[] = roster.map((slot) => {
    const fact = factsBySlot.get(normalizeBed(slot.label));
    const identity = identityFor(fact);
    return {
      bed: slot.label,
      is_side_room: slot.is_side_room,
      occupied: Boolean(fact),
      occupant: identity ? occupantView(identity) : null,
    };
  });

  const unassigned = unassignedFacts
    .map((f) => identityFor(f))
    .filter((p): p is BridgePatient => p !== null)
    .sort(byUpdatedDesc)
    .map(occupantView);

  const occupied = bed_board.filter((b) => b.occupied).length;

  return {
    unit: BED_BOARD_UNIT_LABEL,
    side_rooms: roster.filter((b) => b.is_side_room).map((b) => b.label),
    bed_board,
    unassigned,
    stats: {
      total_beds: roster.length,
      occupied,
      available: roster.length - occupied,
      unassigned: unassignedFacts.length,
    },
    generated_at,
  };
}

/**
 * Safe 503 for any board failure. Logs only the reason code — never the raw
 * error, which could carry row values.
 */
export function bedBoardUnavailableResponse(error: unknown): Response {
  const reason = error instanceof BedBoardUnavailableError ? error.reason : "internal";
  console.error("[bridge] bed board unavailable:", reason);
  const res = json(
    {
      error: "Bed board temporarily unavailable",
      code: "bed_board_unavailable",
      reason,
      retryable: true,
    },
    503,
  );
  res.headers.set("Retry-After", "30");
  return res;
}

export function requestLimit(request: Request, fallback = 500, max = 1000): number {
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}
