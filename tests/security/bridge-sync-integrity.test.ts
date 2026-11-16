import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * Scheduled inbound import (bridge-sync.server.ts / bridge-import.server.ts)
 * with synthetic sync v1 rows and an in-memory database. No network, no live
 * writes. The database-side ownership rules are proven against real SQL in
 * bed-bridge-staged-db.test.ts.
 */
const remote = vi.hoisted(() => ({
  referrals: [] as unknown[] | Error,
  investigations: [] as unknown[] | Error,
  microbiology: [] as unknown[] | Error,
  fetched: [] as string[],
}));
vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => {
    throw new Error("live admin client must not be used in tests");
  },
}));
vi.mock("@/lib/bridge-client.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/bridge-client.server")>();
  return {
    ...real,
    fetchSyncV1: async (resource: "referrals" | "investigations" | "microbiology") => {
      remote.fetched.push(resource);
      const v = remote[resource];
      if (v instanceof Error) throw v;
      return { records: v, snapshotAt: "2026-11-16T12:00:00Z" };
    },
  };
});

import { runBridgeSync } from "@/lib/bridge-sync.server";
import { BridgeFetchError } from "@/lib/bridge-client.server";
import { INBOUND_SYNC_ACTOR_ROLE } from "@/lib/sync-status";

const SYN_PHI = "SYNTHETIC-SECRET-VALUE-ZZ";
const uid = (p: string, n: number) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const liveRef = (n: number, over: Record<string, unknown> = {}) => ({
  id: uid("3", n),
  created_at: "2026-11-16T09:00:00Z",
  updated_at: `2026-11-16T10:00:${String(n).padStart(2, "0")}Z`,
  deleted_at: null,
  status: "pending",
  referral_received_at: "2026-11-16T09:00:00Z",
  age: 70,
  sex: "female",
  current_ward: "SYN",
  current_bed: "B1",
  referring_specialty: "Medicine",
  reason_category: "sepsis",
  ceiling_of_care: "full_escalation",
  resus_status: "for_cpr",
  dnacpr_respect: false,
  anticipated_interventions: [],
  allergies: null,
  weight_kg: null,
  admission_urgency: null,
  infection_status: null,
  news2_score: null,
  hospital_number_enc: SYN_PHI,
  created_by: uid("9", 1),
  ...over,
});
const tomb = (n: number) => ({ id: uid("3", n), updated_at: "2026-11-16T11:00:00Z", deleted_at: "2026-11-16T11:00:00Z" });
const result = (n: number, kind: "investigations" | "microbiology" = "investigations", over: Record<string, unknown> = {}) => ({
  id: uid("4", n),
  patient_id: uid("2", 1),
  [kind === "investigations" ? "category" : "specimen_type"]: "Blood",
  findings: "Normal",
  result_at: "2026-11-16T08:00:00Z",
  created_at: "2026-11-16T08:00:00Z",
  updated_at: `2026-11-16T08:00:${String(n).padStart(2, "0")}Z`,
  ...over,
});

type Rpc = { fn: string; args: Record<string, unknown> };
function db(rpc: (call: Rpc) => { data?: unknown; error?: unknown } = () => ({ data: "inserted" })) {
  const base = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "bridge_sync_events") return { data: null };
    return { data: [] };
  });
  const rpcs: Rpc[] = [];
  return Object.assign(base, {
    rpcs,
    async rpc(fn: string, args: Record<string, unknown>) {
      const call = { fn, args };
      rpcs.push(call);
      const r = rpc(call);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  });
}
const events = (d: ReturnType<typeof db>) =>
  d.calls
    .filter((c) => c.table === "bridge_sync_events" && c.op === "insert")
    .map((c) => c.payload as Record<string, unknown>);

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  remote.referrals = [];
  remote.investigations = [];
  remote.microbiology = [];
  remote.fetched = [];
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("inbound import — patients are never bulk-imported", () => {
  it("fetches only referrals / investigations / microbiology and writes nothing to patients", async () => {
    const d = db();
    const run = await runBridgeSync(d);
    expect(remote.fetched.sort()).toEqual(["investigations", "microbiology", "referrals"]);
    expect(run.sourceOwned).toEqual(["patients"]);
    expect(d.calls.some((c) => c.table === "patients")).toBe(false);
    expect(events(d).some((e) => e.entity === "patients")).toBe(false);
  });
});

describe("inbound import — outcomes are counted honestly", () => {
  it("a valid empty pull writes a success heartbeat for each imported stream", async () => {
    const d = db();
    const run = await runBridgeSync(d);
    expect(run.ok).toBe(true);
    expect(events(d).map((e) => [e.entity, e.status, e.record_count])).toEqual([
      ["referrals", "success", 0],
      ["investigations", "success", 0],
      ["microbiology", "success", 0],
    ]);
    expect(events(d).every((e) => e.actor_role === INBOUND_SYNC_ACTOR_ROLE && e.direction === "pull")).toBe(true);
  });

  it("a refused write is counted as failed, not unchanged, and makes the run not ok", async () => {
    remote.referrals = [liveRef(1), liveRef(2), liveRef(3)];
    const d = db(({ args }) => {
      const id = (args._rec as { id: string }).id;
      if (id === uid("3", 2)) return { error: { code: "23514", message: SYN_PHI } };
      if (id === uid("3", 3)) return { data: "unchanged" };
      return { data: "inserted" };
    });
    const run = await runBridgeSync(d);
    expect(run.results.find((x) => x.entity === "referrals")).toMatchObject({
      fetched: 3, applied: 1, skipped: 1, failed: 1, error: "partial_write_failure",
    });
    expect(run.ok).toBe(false);
    expect(events(d).find((e) => e.entity === "referrals")).toMatchObject({
      status: "error", error_message: "partial_write_failure", record_count: 1,
    });
  });

  it("a local-ownership conflict is reported, never counted as applied", async () => {
    remote.referrals = [liveRef(1)];
    const run = await runBridgeSync(db(() => ({ data: "conflict" })));
    expect(run.results.find((x) => x.entity === "referrals")).toMatchObject({ applied: 0, conflicts: 1, error: "record_conflict" });
    expect(run.ok).toBe(false);
  });

  it("an unexpected helper answer is a failure, not a success", async () => {
    remote.referrals = [liveRef(1)];
    const run = await runBridgeSync(db(() => ({ data: "something_else" })));
    expect(run.results.find((x) => x.entity === "referrals")).toMatchObject({ failed: 1, applied: 0 });
  });
});

describe("inbound import — referral contract", () => {
  it("live rows go to the helper allowlisted; minimal tombstones go as exactly three keys", async () => {
    remote.referrals = [liveRef(1), tomb(2)];
    const d = db(() => ({ data: "updated" }));
    await runBridgeSync(d);
    const payloads = d.rpcs.filter((r) => r.fn === "bridge_import_referral").map((r) => r.args._rec as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).not.toHaveProperty("hospital_number_enc");
    expect(payloads[0]).not.toHaveProperty("created_by");
    expect(payloads[0]).not.toHaveProperty("kind");
    expect(payloads[0]!.deleted_at).toBeNull();
    expect(payloads[1]).toEqual(tomb(2));
    // No unit or actor is ever chosen by the caller.
    for (const r of d.rpcs) expect(Object.keys(r.args)).toEqual(["_rec"]);
  });

  it("one malformed row fails the whole stream before any write; other streams still run", async () => {
    remote.referrals = [liveRef(1), { ...tomb(2), status: "pending" }];
    remote.investigations = [result(1)];
    const d = db();
    const run = await runBridgeSync(d);
    expect(run.results.map((r) => [r.entity, r.error ?? null])).toEqual([
      ["referrals", "malformed_record"],
      ["investigations", null],
      ["microbiology", null],
    ]);
    expect(d.rpcs.some((r) => r.fn === "bridge_import_referral")).toBe(false);
    expect(d.rpcs.filter((r) => r.fn === "bridge_import_result")).toHaveLength(1);
  });

  it("the staged helper not being installed yet refuses to import rather than writing directly", async () => {
    remote.referrals = [liveRef(1)];
    const d = db(() => ({ error: { code: "PGRST202" } }));
    const run = await runBridgeSync(d);
    expect(run.results[0]).toMatchObject({ entity: "referrals", error: "import_unavailable" });
    expect(d.calls.some((c) => c.table === "referrals")).toBe(false);
  });
});

describe("inbound import — results", () => {
  it("canonical microbiology and investigations are passed as type, without a unit", async () => {
    remote.investigations = [result(1)];
    remote.microbiology = [result(2, "microbiology")];
    const d = db();
    await runBridgeSync(d);
    const r = d.rpcs.filter((x) => x.fn === "bridge_import_result");
    expect(r.map((x) => x.args._kind)).toEqual(["investigations", "microbiology"]);
    for (const x of r) {
      expect(Object.keys(x.args).sort()).toEqual(["_kind", "_rec"]);
      expect((x.args._rec as Record<string, unknown>).type).toBe("Blood");
    }
  });

  it("identical → skipped; parent not shared/in unit → unlinked; divergent → conflict", async () => {
    remote.investigations = [result(1), result(2), result(3)];
    const answers = ["identical", "parent_unavailable", "conflict"];
    let i = 0;
    const run = await runBridgeSync(db((c) => (c.fn === "bridge_import_result" ? { data: answers[i++] } : { data: "inserted" })));
    expect(run.results.find((r) => r.entity === "investigations")).toMatchObject({
      applied: 0, skipped: 1, unlinked: 1, conflicts: 1, error: "record_conflict",
    });
  });

  it("bridge unit not resolvable → stream unavailable, nothing counted as written", async () => {
    remote.investigations = [result(1)];
    const run = await runBridgeSync(db((c) => (c.fn === "bridge_import_result" ? { error: { code: "PT503" } } : {})));
    expect(run.results.find((r) => r.entity === "investigations")).toMatchObject({ error: "bridge_unit_unavailable", applied: 0 });
  });
});

describe("inbound import — failures stay per stream and safe", () => {
  it("a partner error is an error for that stream only", async () => {
    remote.investigations = new BridgeFetchError("pagination_invalid");
    const d = db();
    const run = await runBridgeSync(d);
    expect(run.results.map((r) => [r.entity, r.error ?? null])).toEqual([
      ["referrals", null],
      ["investigations", "pagination_invalid"],
      ["microbiology", null],
    ]);
    expect(events(d).map((e) => [e.entity, e.status])).toEqual([
      ["referrals", "success"],
      ["investigations", "error"],
      ["microbiology", "success"],
    ]);
  });

  it("never stores or logs raw partner/database text", async () => {
    remote.referrals = [liveRef(1)];
    remote.microbiology = new Error(`boom ${SYN_PHI}`);
    const d = db(() => ({ error: { code: "XX000", message: SYN_PHI } }));
    const run = await runBridgeSync(d);
    expect(run.results.find((r) => r.entity === "microbiology")!.error).toBe("unexpected");
    const everything = JSON.stringify(events(d)) + JSON.stringify(run) + JSON.stringify(errSpy.mock.calls);
    expect(everything).not.toContain(SYN_PHI);
  });

  it("recovers: a failed run followed by a clean run ends ok", async () => {
    remote.referrals = [liveRef(1)];
    expect((await runBridgeSync(db(() => ({ error: { code: "23514" } })))).ok).toBe(false);
    const second = await runBridgeSync(db());
    expect(second.ok).toBe(true);
    expect(second.results.find((r) => r.entity === "referrals")).toMatchObject({ applied: 1, failed: 0 });
  });
});
