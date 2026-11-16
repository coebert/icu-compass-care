import { describe, it, expect } from "vitest";
import { fakeSupabase, hasFilter, type FakeCall, type FakeResult } from "../support/fake-supabase";
import { readSyncStatus, syncStatusAccess } from "@/lib/sync-status.server";
import {
  INBOUND_SYNC_ACTOR_ROLE,
  overallState,
  resourceState,
  type ResourceEvidence,
} from "@/lib/sync-status";

/** Sync status evidence per resource, from an in-memory event table. */

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

type Ev = {
  entity: string;
  status: "success" | "error";
  created_at: string;
  error_message?: string | null;
  record_count?: number;
};
function eventsDb(events: Ev[], failEntity?: string) {
  return fakeSupabase((c: FakeCall): FakeResult => {
    const entity = c.filters.find(([o, k]) => o === "eq" && k === "entity")?.[2];
    if (entity === failEntity) return { error: { message: "x" } };
    const wantSuccess = hasFilter(c, "eq", "status", "success");
    const match = events
      .filter((e) => e.entity === entity && (!wantSuccess || e.status === "success"))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return { data: match ? { record_count: 0, error_message: null, ...match } : null };
  });
}
const trust = { isTrustAdmin: true, isAuditor: false };

describe("sync status — evidence query", () => {
  it("is restricted (and reads nothing) for staff who cannot see sync events", async () => {
    const d = eventsDb([]);
    expect(await readSyncStatus(d, { isTrustAdmin: false, isAuditor: false })).toEqual({
      access: "restricted",
    });
    expect(d.calls).toHaveLength(0);
  });

  it("queries only this app's inbound pulls, per imported resource, without actor columns", async () => {
    const d = eventsDb([]);
    await readSyncStatus(d, trust);
    // Patients are recorded here (source-owned), never imported: no query.
    expect(d.calls).toHaveLength(6);
    for (const c of d.calls) {
      expect(c.table).toBe("bridge_sync_events");
      expect(c.columns).not.toMatch(/actor/);
      expect(hasFilter(c, "eq", "direction", "pull")).toBe(true);
      expect(hasFilter(c, "eq", "actor_role", INBOUND_SYNC_ACTOR_ROLE)).toBe(true);
    }
    const entities = new Set(d.calls.map((c) => c.filters.find(([, k]) => k === "entity")?.[2]));
    expect([...entities].sort()).toEqual(["investigations", "microbiology", "referrals"]);
  });

  it("clinical members of the bridge unit see the same safe status through server code, and can't retry", async () => {
    const own = eventsDb([]);
    const server = eventsDb([{ entity: "referrals", status: "success", created_at: ago(1) }]);
    const clin = { isTrustAdmin: false, isAuditor: false, isClinician: true, unitIds: ["uRadnor"] };
    const s = await readSyncStatus(own, clin, { bridgeUnitId: "uRadnor", serverClient: async () => server });
    expect(own.calls).toHaveLength(0); // no table access of their own
    expect(s.access === "granted" && s.canRetry).toBe(false);
    for (const c of server.calls) expect(c.columns).not.toMatch(/actor|email/);
    expect(JSON.stringify(s)).not.toMatch(/actor|email/);
  });

  it("clinicians of other units, or when the bridge unit is unknown, see nothing", async () => {
    const server = eventsDb([]);
    const other = { isTrustAdmin: false, isAuditor: false, isClinician: true, unitIds: ["uOther"] };
    expect(await readSyncStatus(eventsDb([]), other, { bridgeUnitId: "uRadnor", serverClient: async () => server })).toEqual({ access: "restricted" });
    const member = { ...other, unitIds: ["uRadnor"] };
    expect(await readSyncStatus(eventsDb([]), member, { bridgeUnitId: null, serverClient: async () => server })).toEqual({ access: "restricted" });
    expect(server.calls).toHaveLength(0);
    expect(syncStatusAccess({ isTrustAdmin: false, isAuditor: false, unitIds: ["uRadnor"] }, "uRadnor")).toBe("restricted");
    expect(syncStatusAccess({ isTrustAdmin: false, isAuditor: false, isUnitAdmin: true, unitIds: ["uRadnor"] }, "uRadnor")).toBe("scoped_clinical");
  });

  it("auditors can view but not retry; Trust admins can retry", async () => {
    const a = await readSyncStatus(eventsDb([]), { isTrustAdmin: false, isAuditor: true });
    const t = await readSyncStatus(eventsDb([]), trust);
    expect(a.access === "granted" && a.canRetry).toBe(false);
    expect(t.access === "granted" && t.canRetry).toBe(true);
  });

  it("maps legacy raw error text to a withheld code", async () => {
    const s = await readSyncStatus(
      eventsDb([
        {
          entity: "referrals",
          status: "error",
          created_at: ago(1),
          error_message: "Partner said SYN-ZZ",
        },
      ]),
      trust,
    );
    const p = s.access === "granted" ? s.resources.find((r) => r.entity === "referrals") : null;
    expect(p).toMatchObject({
      entity: "referrals",
      lastAttemptOk: false,
      lastAttemptCode: "unknown",
    });
    expect(JSON.stringify(s)).not.toContain("SYN-ZZ");
  });

  it("a query failure for one resource marks only that resource unavailable", async () => {
    const s = await readSyncStatus(
      eventsDb([{ entity: "investigations", status: "success", created_at: ago(1) }], "referrals"),
      trust,
    );
    if (s.access !== "granted") throw new Error("expected granted");
    expect(s.resources.map((r) => [r.entity, r.unavailable])).toEqual([
      ["patients", false],
      ["investigations", false],
      ["referrals", true],
      ["microbiology", false],
    ]);
  });
});

const ev = (over: Partial<ResourceEvidence>): ResourceEvidence => ({
  entity: "patients",
  unavailable: false,
  lastAttemptAt: ago(2),
  lastAttemptOk: true,
  lastAttemptCode: null,
  lastSuccessAt: ago(2),
  lastSuccessCount: 0,
  ...over,
});

describe("sync status — per-resource state", () => {
  it("valid empty pull (0 records) is up to date", () => {
    expect(resourceState(ev({ lastSuccessCount: 0 }), NOW, 30)).toBe("ok");
  });
  it("latest attempt failed is failed even with an older success", () => {
    expect(
      resourceState(
        ev({
          lastAttemptAt: ago(1),
          lastAttemptOk: false,
          lastAttemptCode: "partner_http_error",
          lastSuccessAt: ago(10),
        }),
        NOW,
        30,
      ),
    ).toBe("failed");
  });
  it("partial write failure reads as incomplete", () => {
    expect(
      resourceState(
        ev({ lastAttemptOk: false, lastAttemptCode: "partial_write_failure" }),
        NOW,
        30,
      ),
    ).toBe("incomplete");
  });
  it("no success for longer than the threshold is delayed", () => {
    expect(resourceState(ev({ lastAttemptAt: ago(45), lastSuccessAt: ago(45) }), NOW, 30)).toBe(
      "delayed",
    );
  });
  it("no attempts is 'never'; query error is 'unavailable'", () => {
    expect(
      resourceState(ev({ lastAttemptAt: null, lastSuccessAt: null, lastAttemptOk: null }), NOW, 30),
    ).toBe("never");
    expect(resourceState(ev({ unavailable: true }), NOW, 30)).toBe("unavailable");
  });
  it("recovery: a newer success after a failure is ok again", () => {
    expect(
      resourceState(
        ev({ lastAttemptAt: ago(1), lastAttemptOk: true, lastSuccessAt: ago(1) }),
        NOW,
        30,
      ),
    ).toBe("ok");
  });
  it("a success on another stream cannot hide a failure", () => {
    expect(overallState(["ok", "ok", "failed", "ok"])).toBe("failed");
    expect(overallState(["ok", "incomplete", "ok", "ok"])).toBe("incomplete");
    expect(overallState(["ok", "ok", "ok", "unavailable"])).toBe("unavailable");
    expect(overallState(["ok", "delayed", "ok", "ok"])).toBe("delayed");
    expect(overallState(["ok", "ok", "ok", "ok"])).toBe("ok");
    expect(overallState([])).toBe("unavailable");
  });
});
