import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * Cross-app review (read-only): never reports "matched" or "only on one side"
 * from data that might be incomplete or that compares the wrong revision.
 * Synthetic rows, in-memory database, no network.
 */
const h = vi.hoisted(() => ({
  local: {} as Record<string, unknown[] | "error">,
  remote: { referrals: [] as unknown[], notifications: [] as unknown[] | Error, audit: [] as unknown[] | Error },
}));
vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () =>
    fakeSupabase((c: FakeCall): FakeResult => {
      const v = h.local[c.table];
      return v === "error" ? { error: { message: "x" } } : { data: v ?? [] };
    }),
}));
vi.mock("@/lib/bridge-client.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/bridge-client.server")>();
  const take = (v: unknown[] | Error) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    ...real,
    fetchSyncV1: async () => ({ records: h.remote.referrals, snapshotAt: "2026-11-16T12:00:00Z" }),
    fetchPartnerNotificationsForReview: () => take(h.remote.notifications),
    fetchPartnerAuditLogForReview: () => take(h.remote.audit),
  };
});

import { buildReconciliation, LOCAL_REVIEW_LIMIT } from "@/lib/reconcile.server";
import { BridgeFetchError } from "@/lib/bridge-client.server";

const RID = "30000000-0000-4000-8000-000000000001";
const content = {
  deleted_at: null, status: "pending", referral_received_at: "2026-11-16T09:00:00Z", age: 70, sex: "female",
  current_ward: "SYN", current_bed: "B1", referring_specialty: "Medicine", reason_category: "sepsis",
  ceiling_of_care: "full_escalation", resus_status: "for_cpr", dnacpr_respect: false, anticipated_interventions: [],
  allergies: null, weight_kg: null, admission_urgency: null, infection_status: null, news2_score: null,
};
const remoteRef = (over: Record<string, unknown> = {}) => ({
  id: RID, created_at: "2026-11-16T09:00:00Z", updated_at: "2026-11-16T10:00:00Z", ...content, ...over,
});

beforeEach(() => {
  h.local = {};
  h.remote = { referrals: [], notifications: [], audit: [] };
});
const get = async (entity: string) => (await buildReconciliation()).find((e) => e.entity === entity)!;

describe("cross-app review", () => {
  it("referrals compare imported content, not our own receiver timestamp", async () => {
    h.remote.referrals = [remoteRef()];
    h.local.referrals = [{ id: RID, updated_at: "2026-11-16T10:00:07.123456+00:00", ...content, referral_received_at: "2026-11-16T09:00:00+00:00" }];
    const r = await get("referrals");
    expect(r).toMatchObject({ matched: 1, mismatches: [] });
  });
  it("different content is shown as diverged", async () => {
    h.remote.referrals = [remoteRef({ status: "admitted" })];
    h.local.referrals = [{ id: RID, updated_at: "2026-11-16T10:00:00Z", ...content }];
    expect((await get("referrals")).mismatches[0]).toMatchObject({ state: "diverged" });
  });
  it("a remote tombstone matches a local row already marked deleted", async () => {
    h.remote.referrals = [{ id: RID, updated_at: "2026-11-16T11:00:00Z", deleted_at: "2026-11-16T11:00:00Z" }];
    h.local.referrals = [{ id: RID, updated_at: "x", ...content, deleted_at: "2026-11-16T11:00:00Z" }];
    expect(await get("referrals")).toMatchObject({ matched: 1 });
  });
  it("a possibly truncated partner review feed is an error, never 'matched' or 'local only'", async () => {
    h.remote.audit = new BridgeFetchError("review_truncated");
    h.local.audit_log = [{ id: "a1" }];
    const r = await get("audit_log");
    expect(r.error).toBeTruthy();
    expect(r.mismatches).toEqual([]);
    expect(r.matched).toBe(0);
  });
  it("a local read that comes back full is refused too", async () => {
    h.local.notifications = Array.from({ length: LOCAL_REVIEW_LIMIT + 1 }, (_, i) => ({ id: `n${i}` }));
    const r = await get("notifications");
    expect(r.error).toBeTruthy();
    expect(r.mismatches).toEqual([]);
  });
  it("a local read failure is an error, not an empty side", async () => {
    h.local.referrals = "error";
    h.remote.referrals = [remoteRef()];
    const r = await get("referrals");
    expect(r.error).toBeTruthy();
    expect(r.mismatches).toEqual([]);
  });
});
