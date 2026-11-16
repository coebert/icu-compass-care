import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * Inbound partner sync (bridge-sync.server.ts / bridge-client.server.ts) with
 * synthetic rows and an in-memory database. No network, no live writes.
 */

const remote = vi.hoisted(() => ({
  patients: [] as unknown[] | Error,
  investigations: [] as unknown[] | Error,
  referrals: [] as unknown[] | Error,
  microbiology: [] as unknown[] | Error,
}));

vi.mock("@/lib/patient-crypto.server", () => ({
  encryptPatientPayload: (r: unknown) => r,
}));
vi.mock("@/lib/audit", () => ({ writeAudit: async () => {} }));
vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => {
    throw new Error("live admin client must not be used in tests");
  },
}));
vi.mock("@/lib/bridge-client.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/bridge-client.server")>();
  const take = (k: keyof typeof remote) => async () => {
    const v = remote[k];
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    ...real,
    fetchPartnerPatients: take("patients"),
    fetchPartnerInvestigations: take("investigations"),
    fetchPartnerReferrals: take("referrals"),
    fetchPartnerMicrobiology: take("microbiology"),
  };
});

import { runBridgeSync } from "@/lib/bridge-sync.server";
import { BridgeFetchError, expectRecords } from "@/lib/bridge-client.server";
import { INBOUND_SYNC_ACTOR_ROLE } from "@/lib/sync-status";

const SYN_PHI = "SYNTHETIC-SECRET-VALUE-ZZ";
const rec = (id: string, updated_at = "2026-02-01T00:00:00Z", extra: Record<string, unknown> = {}) => ({
  id,
  updated_at,
  ...extra,
});

function db(opts: { local?: Record<string, unknown[]>; failUpsertIds?: string[]; readError?: string[] } = {}) {
  return fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "bridge_sync_events") return { data: null };
    if (c.op === "select") {
      if (opts.readError?.includes(c.table)) return { error: { message: SYN_PHI } };
      return { data: opts.local?.[c.table] ?? [] };
    }
    if (c.op === "upsert") {
      const id = (c.payload as { id: string }).id;
      return opts.failUpsertIds?.includes(id) ? { error: { message: `violates fk ${SYN_PHI}` } } : { data: null };
    }
    return { data: null };
  });
}
const events = (d: ReturnType<typeof db>) =>
  d.calls
    .filter((c) => c.table === "bridge_sync_events" && c.op === "insert")
    .map((c) => c.payload as Record<string, unknown>);

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  remote.patients = [];
  remote.investigations = [];
  remote.referrals = [];
  remote.microbiology = [];
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("inbound sync — outcomes are counted honestly", () => {
  it("a failed upsert is counted as failed, not unchanged, and makes the run not ok", async () => {
    remote.referrals = [rec("r1"), rec("r2"), rec("r3")];
    const d = db({ failUpsertIds: ["r2"], local: { referrals: [rec("r3", "2026-02-01T00:00:00Z")] } });
    const run = await runBridgeSync(d);
    const r = run.results.find((x) => x.entity === "referrals")!;
    expect(r).toMatchObject({ fetched: 3, applied: 1, skipped: 1, failed: 1, error: "partial_write_failure" });
    expect(run.ok).toBe(false);
    const ev = events(d).find((e) => e.entity === "referrals")!;
    expect(ev).toMatchObject({
      direction: "pull",
      status: "error",
      error_message: "partial_write_failure",
      record_count: 1,
      actor_role: INBOUND_SYNC_ACTOR_ROLE,
    });
  });

  it("a valid empty pull writes a success heartbeat for all four resources", async () => {
    const d = db();
    const run = await runBridgeSync(d);
    expect(run.ok).toBe(true);
    expect(events(d).map((e) => [e.entity, e.status, e.record_count])).toEqual([
      ["patients", "success", 0],
      ["investigations", "success", 0],
      ["referrals", "success", 0],
      ["microbiology", "success", 0],
    ]);
    expect(events(d).every((e) => e.actor_role === INBOUND_SYNC_ACTOR_ROLE)).toBe(true);
  });

  it("a malformed feed is an error for that resource only — others still succeed", async () => {
    remote.investigations = new BridgeFetchError("malformed_response");
    remote.patients = [rec("p1")];
    const d = db();
    const run = await runBridgeSync(d);
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => [r.entity, r.error ?? null])).toEqual([
      ["patients", null],
      ["investigations", "malformed_response"],
      ["referrals", null],
      ["microbiology", null],
    ]);
    expect(d.calls.some((c) => c.table === "investigations" && c.op === "upsert")).toBe(false);
    expect(events(d).map((e) => [e.entity, e.status])).toEqual([
      ["patients", "success"],
      ["investigations", "error"],
      ["referrals", "success"],
      ["microbiology", "success"],
    ]);
  });

  it("never stores or logs raw partner/database text", async () => {
    remote.patients = [rec("p1")];
    remote.microbiology = new Error(`boom ${SYN_PHI}`);
    const d = db({ failUpsertIds: ["p1"], readError: [] });
    const run = await runBridgeSync(d);
    expect(run.results.find((r) => r.entity === "microbiology")!.error).toBe("unexpected");
    const everything = JSON.stringify(events(d)) + JSON.stringify(run) + JSON.stringify(errSpy.mock.calls);
    expect(everything).not.toContain(SYN_PHI);
  });

  it("a local read failure is recorded as local_read_failed with nothing written", async () => {
    remote.patients = [rec("p1")];
    const d = db({ readError: ["patients"] });
    const run = await runBridgeSync(d);
    expect(run.results[0]).toMatchObject({ entity: "patients", error: "local_read_failed", applied: 0 });
    expect(d.calls.some((c) => c.table === "patients" && c.op === "upsert")).toBe(false);
  });

  it("stays idempotent: equal or older partner copies are skipped, not rewritten", async () => {
    remote.patients = [rec("p1", "2026-02-01T00:00:00Z"), rec("p2", "2026-01-01T00:00:00Z")];
    const d = db({ local: { patients: [rec("p1", "2026-02-01T00:00:00Z"), rec("p2", "2026-03-01T00:00:00Z")] } });
    const run = await runBridgeSync(d);
    expect(run.results[0]).toMatchObject({ applied: 0, skipped: 2, failed: 0 });
    expect(d.calls.some((c) => c.op === "upsert")).toBe(false);
    expect(run.ok).toBe(true);
  });

  it("never lets a pulled patient overwrite the local sharing decision", async () => {
    remote.patients = [
      rec("p1", "2026-02-01T00:00:00Z", {
        shared_with_partner: true,
        shared_with_partner_at: "x",
        shared_with_partner_by: "y",
        bed: "3",
      }),
    ];
    const d = db();
    await runBridgeSync(d);
    const up = d.calls.find((c) => c.table === "patients" && c.op === "upsert")!;
    expect(up.payload).toEqual({ id: "p1", updated_at: "2026-02-01T00:00:00Z", bed: "3" });
  });

  it("recovers: a failed run followed by a clean run ends ok", async () => {
    remote.referrals = [rec("r1")];
    const first = await runBridgeSync(db({ failUpsertIds: ["r1"] }));
    expect(first.ok).toBe(false);
    const second = await runBridgeSync(db());
    expect(second.ok).toBe(true);
    expect(second.results.find((r) => r.entity === "referrals")).toMatchObject({ applied: 1, failed: 0 });
  });
});

describe("partner feed parsing — missing or malformed lists are rejected", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as BridgeFetchError).code;
    }
    return "accepted";
  };
  it("accepts a present array, including an empty one", () => {
    expect(expectRecords({ patients: [] }, "patients")).toEqual([]);
    expect(expectRecords({ patients: [{ id: "a", updated_at: null }] }, "patients")).toHaveLength(1);
  });
  it("rejects a missing, null or non-array list instead of treating it as empty", () => {
    expect(code(() => expectRecords({}, "patients"))).toBe("malformed_response");
    expect(code(() => expectRecords({ patients: null }, "patients"))).toBe("malformed_response");
    expect(code(() => expectRecords({ patients: {} }, "patients"))).toBe("malformed_response");
    expect(code(() => expectRecords(null, "patients"))).toBe("malformed_response");
    expect(code(() => expectRecords([], "patients"))).toBe("malformed_response");
  });
  it("rejects records without a usable id or with a non-text updated_at", () => {
    expect(code(() => expectRecords({ patients: [null] }, "patients"))).toBe("malformed_record");
    expect(code(() => expectRecords({ patients: [{ id: "" }] }, "patients"))).toBe("malformed_record");
    expect(code(() => expectRecords({ patients: [{ id: 5 }] }, "patients"))).toBe("malformed_record");
    expect(code(() => expectRecords({ patients: [{ id: "a", updated_at: 1 }] }, "patients"))).toBe(
      "malformed_record",
    );
  });
});
