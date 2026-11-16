import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, hasFilter, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * Partner bed board occupancy (src/lib/bridge-beds.ts), synthetic rows only.
 * A withheld (not shared) patient must still hold their bed; only shared rows
 * may carry identity; any doubt must fail closed with a 503.
 */

vi.mock("@/lib/patient-crypto.server", () => ({
  decryptPatientRows: (rows: unknown[] | null) => rows ?? [],
}));
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/admin-db.server", () => ({ getAdmin: async () => holder.db }));
vi.mock("@/lib/api-bridge.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api-bridge.server")>();
  return {
    ...real,
    authorizeBridge: async () => ({ ok: true, actor: { id: "x", role: "clinician" } }),
    logSync: async () => {},
  };
});

import {
  buildBridgeBedBoard,
  BedBoardUnavailableError,
  OCCUPANCY_FACT_COLUMNS,
} from "@/lib/bridge-beds";

const UNIT = "00000000-0000-4000-8000-00000000u001";
const roster = [
  { label: "1", is_side_room: true, position: 1 },
  { label: "2", is_side_room: false, position: 2 },
  { label: "3", is_side_room: false, position: 3 },
];
type Fact = { id: string; bed: string | null; shared_with_partner: boolean | null };
const shared = (id: string, bed: string | null) => ({
  id,
  bed,
  status: "admitted",
  location_type: "icu",
  shared_with_partner: true,
  full_name: "ZZ",
  hospital_number: `SYN-${id}`,
  age: 50,
  admission_date: "2026-01-01",
  tep_in_place: null,
  dnacpr_decision: null,
  outstanding_tasks: null,
  wardable: false,
  wardable_at: null,
  updated_at: "2026-01-02T00:00:00+00:00",
  current_management: "SYNTHETIC — must never be exposed",
});

function world(opts: {
  facts: Fact[];
  identities?: ReturnType<typeof shared>[];
  roster?: unknown;
  rosterError?: boolean;
  unitError?: boolean;
  factError?: boolean;
  count?: number;
  identityError?: boolean;
}) {
  return fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "icu_units")
      return opts.unitError ? { error: { message: "x" } } : { data: { id: UNIT, code: "SDH-RADNOR" } };
    if (c.table === "icu_beds")
      return opts.rosterError ? { error: { message: "x" } } : { data: opts.roster ?? roster };
    if (c.table === "patients" && c.columns === OCCUPANCY_FACT_COLUMNS) {
      return opts.factError
        ? { error: { message: "x" } }
        : { data: opts.facts, count: opts.count ?? opts.facts.length };
    }
    if (c.table === "patients" && c.columns === "*") {
      return opts.identityError ? { error: { message: "x" } } : { data: opts.identities ?? [] };
    }
    throw new Error(`unexpected query on ${c.table}`);
  });
}

async function reason(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BedBoardUnavailableError);
    return (e as BedBoardUnavailableError).reason;
  }
  throw new Error("expected the board to fail closed");
}

describe("bridge bed board — physical occupancy vs shared identity", () => {
  it("shows a withheld patient's bed as occupied with no occupant, never vacant", async () => {
    const db = world({ facts: [{ id: "w1", bed: "2", shared_with_partner: false }] });
    const board = await buildBridgeBedBoard(db);
    expect(board.bed_board[1]).toEqual({
      bed: "2",
      is_side_room: false,
      occupied: true,
      occupant: null,
    });
    expect(board.stats).toEqual({ total_beds: 3, occupied: 1, available: 2, unassigned: 0 });
    // No identity read at all when nothing is shared.
    expect(db.calls.filter((c) => c.table === "patients" && c.columns === "*")).toHaveLength(0);
  });

  it("reads occupancy with minimal columns, scoped to the fixed unit and active ICU rows", async () => {
    const db = world({ facts: [] });
    await buildBridgeBedBoard(db);
    const fact = db.calls.find((c) => c.columns === OCCUPANCY_FACT_COLUMNS)!;
    expect(OCCUPANCY_FACT_COLUMNS).toBe("id, bed, shared_with_partner");
    expect(hasFilter(fact, "eq", "unit_id", UNIT)).toBe(true);
    expect(hasFilter(fact, "eq", "location_type", "icu")).toBe(true);
    expect(hasFilter(fact, "in", "status", ["admitted", "referred"])).toBe(true);
    expect(hasFilter(fact, "eq", "shared_with_partner")).toBe(false);
  });

  it("only requests identity for rows still shared, and exposes the slim occupant fields", async () => {
    const db = world({
      facts: [
        { id: "s1", bed: "1", shared_with_partner: true },
        { id: "w1", bed: "3", shared_with_partner: false },
      ],
      identities: [shared("s1", "1")],
    });
    const board = await buildBridgeBedBoard(db);
    const idQuery = db.calls.find((c) => c.table === "patients" && c.columns === "*")!;
    expect(hasFilter(idQuery, "eq", "shared_with_partner", true)).toBe(true);
    expect(hasFilter(idQuery, "eq", "unit_id", UNIT)).toBe(true);
    expect(Object.keys(board.bed_board[0].occupant!).sort()).toEqual(
      [
        "id",
        "full_name",
        "hospital_number",
        "age",
        "status",
        "bed",
        "admission_date",
        "tep_in_place",
        "dnacpr_decision",
        "outstanding_tasks",
        "wardable",
        "wardable_at",
        "updated_at",
      ].sort(),
    );
    expect(board.bed_board[0].occupant!.id).toBe("s1");
    expect(board.bed_board[2]).toEqual({
      bed: "3",
      is_side_room: false,
      occupied: true,
      occupant: null,
    });
    expect(board.stats.occupied).toBe(2);
    expect(board.stats.available).toBe(1);
  });

  it("counts every unassigned patient but lists only shared identities", async () => {
    const db = world({
      facts: [
        { id: "s1", bed: null, shared_with_partner: true },
        { id: "w1", bed: "99", shared_with_partner: false },
        { id: "w2", bed: "", shared_with_partner: false },
      ],
      identities: [shared("s1", null)],
    });
    const board = await buildBridgeBedBoard(db);
    expect(board.unassigned.map((u) => u.id)).toEqual(["s1"]);
    expect(board.stats.unassigned).toBe(3);
    expect(board.stats.occupied).toBe(0);
  });

  it("treats a patient un-shared between the two reads as withheld, still occupied", async () => {
    const db = world({
      facts: [{ id: "s1", bed: "2", shared_with_partner: true }],
      identities: [],
    });
    const board = await buildBridgeBedBoard(db);
    expect(board.bed_board[1]).toEqual({
      bed: "2",
      is_side_room: false,
      occupied: true,
      occupant: null,
    });
  });

  it("keeps the response shape and adds an ISO generated_at", async () => {
    const before = Date.now();
    const board = await buildBridgeBedBoard(world({ facts: [] }));
    expect(Object.keys(board).sort()).toEqual(
      ["bed_board", "generated_at", "side_rooms", "stats", "unassigned", "unit", "unit_code"].sort(),
    );
    expect(board.unit).toBe("Radnor Critical Care Unit");
    expect(board.unit_code).toBe("SDH-RADNOR");
    expect(board.side_rooms).toEqual(["1"]);
    expect(new Date(board.generated_at).toISOString()).toBe(board.generated_at);
    expect(Date.parse(board.generated_at)).toBeGreaterThanOrEqual(before - 1);
  });

  it("uses the default roster only for an explicitly empty, successfully read roster", async () => {
    const board = await buildBridgeBedBoard(world({ facts: [], roster: [] }));
    expect(board.stats.total_beds).toBe(12);
  });
});

describe("bridge bed board — fails closed instead of claiming capacity", () => {
  it("roster read error does not fall back to defaults", async () => {
    expect(await reason(buildBridgeBedBoard(world({ facts: [], rosterError: true })))).toBe(
      "roster_unavailable",
    );
  });
  it("duplicate normalised roster labels", async () => {
    const dup = [
      { label: "3", is_side_room: false, position: 1 },
      { label: " 3 ", is_side_room: false, position: 2 },
    ];
    expect(await reason(buildBridgeBedBoard(world({ facts: [], roster: dup })))).toBe(
      "roster_duplicate_label",
    );
  });
  it("malformed roster rows", async () => {
    expect(
      await reason(
        buildBridgeBedBoard(world({ facts: [], roster: [{ label: "", is_side_room: false }] })),
      ),
    ).toBe("roster_malformed");
    expect(await reason(buildBridgeBedBoard(world({ facts: [], roster: { label: "1" } })))).toBe(
      "roster_malformed",
    );
  });
  it("two active patients assigned to the same slot (normalised)", async () => {
    const facts = [
      { id: "a", bed: "2", shared_with_partner: false },
      { id: "b", bed: " 2", shared_with_partner: true },
    ];
    expect(await reason(buildBridgeBedBoard(world({ facts })))).toBe("ambiguous_assignment");
  });
  it("unit lookup failure", async () => {
    expect(await reason(buildBridgeBedBoard(world({ facts: [], unitError: true })))).toBe(
      "unit_unavailable",
    );
  });
  it("occupancy read failure", async () => {
    expect(await reason(buildBridgeBedBoard(world({ facts: [], factError: true })))).toBe(
      "occupancy_unavailable",
    );
  });
  it("malformed occupancy rows (missing share flag, duplicate id, non-text bed)", async () => {
    for (const facts of [
      [{ id: "a", bed: "1", shared_with_partner: null }],
      [
        { id: "a", bed: "1", shared_with_partner: false },
        { id: "a", bed: "2", shared_with_partner: false },
      ],
      [{ id: "a", bed: 7 as unknown as string, shared_with_partner: false }],
    ]) {
      expect(await reason(buildBridgeBedBoard(world({ facts })))).toBe("occupancy_malformed");
    }
  });
  it("truncated occupancy result (count disagrees with rows)", async () => {
    const facts = [{ id: "a", bed: "1", shared_with_partner: false }];
    expect(await reason(buildBridgeBedBoard(world({ facts, count: 2 })))).toBe(
      "occupancy_incomplete",
    );
  });
  it("identity read failure", async () => {
    const facts = [{ id: "s1", bed: "1", shared_with_partner: true }];
    expect(await reason(buildBridgeBedBoard(world({ facts, identityError: true })))).toBe(
      "identity_unavailable",
    );
  });
  it("patient moved or admitted between the two reads", async () => {
    const facts = [{ id: "s1", bed: "1", shared_with_partner: true }];
    expect(
      await reason(buildBridgeBedBoard(world({ facts, identities: [shared("s1", "3")] }))),
    ).toBe("identity_mismatch");
    expect(
      await reason(
        buildBridgeBedBoard(world({ facts, identities: [shared("s1", "1"), shared("new", "2")] })),
      ),
    ).toBe("identity_mismatch");
  });
});

describe("partner bed endpoints return a safe 503", () => {
  beforeEach(() => {
    holder.db = world({ facts: [], rosterError: true });
  });

  for (const path of ["bridge.beds", "bridge.bed_occupancies", "bridge.bed_outliers"]) {
    it(`${path} refuses rather than reporting vacancy`, async () => {
      const mod = await import(`@/routes/api/public/${path}.ts`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const GET = (mod.Route as any).options.server.handlers.GET;
      const res: Response = await GET({ request: new Request("http://isolated.test/x") });
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(await res.json()).toEqual({
        error: "Bed board temporarily unavailable",
        code: "bed_board_unavailable",
        reason: "roster_unavailable",
        retryable: true,
      });
    });
  }

  it("bridge.beds still returns the normal board when data is sound", async () => {
    holder.db = world({ facts: [{ id: "w1", bed: "1", shared_with_partner: false }] });
    const mod = await import("@/routes/api/public/bridge.beds.ts");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const GET = (mod.Route as any).options.server.handlers.GET;
    const res: Response = await GET({ request: new Request("http://isolated.test/x") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bed_board[0]).toEqual({
      bed: "1",
      is_side_room: true,
      occupied: true,
      occupant: null,
    });
    expect(body.stats).toEqual({ total_beds: 3, occupied: 1, available: 2, unassigned: 0 });
  });
});

describe("identity lookup is limited to confirmed-shared rows", () => {
  it("asks only for the IDs that were shared in the occupancy read", async () => {
    const db = world({
      facts: [
        { id: "s1", bed: "1", shared_with_partner: true },
        { id: "w1", bed: "2", shared_with_partner: false },
      ],
      identities: [shared("s1", "1")],
    });
    await buildBridgeBedBoard(db);
    const idCall = db.calls.find((c) => c.table === "patients" && c.columns === "*");
    expect(idCall).toBeDefined();
    expect(hasFilter(idCall!, "in", "id", ["s1"])).toBe(true);
    expect(hasFilter(idCall!, "eq", "shared_with_partner", true)).toBe(true);
  });
});
