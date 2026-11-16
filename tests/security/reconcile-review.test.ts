import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * Cross-app review (read-only): never reports "matched" or "only on one side"
 * from data that might be incomplete, untrusted or compared on the wrong
 * revision. Synthetic rows, in-memory stand-ins, no network.
 */
const h = vi.hoisted(() => ({
  local: {} as Record<string, unknown[] | "error">,
  /** Simulated REST row cap (PostgREST max_rows): rows per response, whatever was asked. */
  maxRows: 1000,
  review: null as unknown,
  reviewError: null as unknown,
  remote: {
    referrals: [] as unknown[],
    notifications: { records: [], complete: true } as unknown,
    audit: { records: [], complete: true } as unknown,
  },
  calls: [] as FakeCall[],
}));
vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => {
    const c = fakeSupabase((call: FakeCall): FakeResult => {
      h.calls.push(call);
      const v = h.local[call.table];
      if (v === "error") return { error: { message: "x" } };
      const gt = call.filters.find((f) => f[0] === "gt")?.[2] as string | undefined;
      const lim = (call.filters.find((f) => f[0] === "limit")?.[1] as number) ?? Infinity;
      const rows = (v ?? [])
        .filter((r) => gt === undefined || String((r as { id: string }).id) > gt)
        .slice(0, Math.min(lim, h.maxRows));
      return { data: rows };
    });
    return Object.assign(c, {
      rpc: async () => ({ data: h.review, error: h.reviewError }),
    });
  },
}));
vi.mock("@/lib/bridge-client.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/bridge-client.server")>();
  const take = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    ...real,
    fetchSyncV1: async () => ({ records: h.remote.referrals, snapshotAt: "2026-11-16T12:00:00Z" }),
    fetchPartnerNotificationsForReview: () => take(h.remote.notifications),
    fetchPartnerAuditLogForReview: () => take(h.remote.audit),
  };
});

import {
  buildReconciliation,
  classifyReferral,
  readLocalBounded,
  LOCAL_REVIEW_LIMIT,
  REVIEW_ERROR_TEXT,
} from "@/lib/reconcile.server";
import { BridgeFetchError } from "@/lib/bridge-client.server";

const RID = "30000000-0000-4000-8000-000000000001";
const content = {
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
};
const remoteRef = (over: Record<string, unknown> = {}) => ({
  id: RID,
  created_at: "2026-11-16T09:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...content,
  ...over,
});
const trusted = {
  source_revision: "2026-11-16T10:00:00+00:00",
  watermark: false,
  receiver_matches: true,
};
const reviewRow = (local: unknown, provenance: unknown, id = RID) => ({
  id,
  local,
  local_updated_at: local ? "2026-11-16T10:00:07.123456+00:00" : null,
  provenance,
});
const ids = (n: number, prefix = "") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(6, "0")}` }));

beforeEach(() => {
  h.local = {};
  h.maxRows = 1000;
  h.review = { complete: true, rows: [] };
  h.reviewError = null;
  h.calls = [];
  h.remote = {
    referrals: [],
    notifications: { records: [], complete: true },
    audit: { records: [], complete: true },
  };
});
const get = async (entity: string) =>
  (await buildReconciliation()).find((e) => e.entity === entity)!;

describe("referral review follows import ownership", () => {
  it("equal content on a trusted imported copy is matched (receiver timestamp ignored)", async () => {
    h.remote.referrals = [remoteRef()];
    h.review = {
      complete: true,
      rows: [reviewRow({ ...content, referral_received_at: "2026-11-16T09:00:00+00:00" }, trusted)],
    };
    expect(await get("referrals")).toMatchObject({ matched: 1, mismatches: [] });
  });
  it("equal content WITHOUT provenance is a conflict, never 'in sync' and never pullable", async () => {
    h.remote.referrals = [remoteRef()];
    h.review = { complete: true, rows: [reviewRow(content, null)] };
    const r = await get("referrals");
    expect(r.matched).toBe(0);
    expect(r.mismatches[0]).toMatchObject({
      state: "conflict",
      reason: "not_imported",
      pullable: false,
    });
  });
  it("a recorded partner deletion (watermark) is matched, not 'only on partner'", async () => {
    h.remote.referrals = [
      { id: RID, updated_at: "2026-11-16T11:00:00Z", deleted_at: "2026-11-16T11:00:00Z" },
    ];
    h.review = {
      complete: true,
      rows: [
        reviewRow(null, {
          source_revision: "2026-11-16T11:00:00+00:00",
          watermark: true,
          receiver_matches: false,
        }),
      ],
    };
    expect(await get("referrals")).toMatchObject({ matched: 1, mismatches: [], localCount: 0 });
  });
  it("a watermark with nothing on either side is not shown or counted", async () => {
    h.review = {
      complete: true,
      rows: [
        reviewRow(null, {
          source_revision: "2026-11-16T11:00:00Z",
          watermark: true,
          receiver_matches: false,
        }),
      ],
    };
    expect(await get("referrals")).toMatchObject({ matched: 0, mismatches: [], localCount: 0 });
  });
  it("a referral only here is the app's own record, not waiting for the partner", async () => {
    h.review = { complete: true, rows: [reviewRow(content, null)] };
    expect((await get("referrals")).mismatches[0]).toMatchObject({
      state: "local_only",
      reason: "local_record",
      pullable: false,
    });
  });
  it("different content on a trusted copy with a newer partner revision is pullable", async () => {
    h.remote.referrals = [remoteRef({ status: "admitted", updated_at: "2026-11-16T12:00:00Z" })];
    h.review = { complete: true, rows: [reviewRow(content, trusted)] };
    expect((await get("referrals")).mismatches[0]).toMatchObject({
      state: "diverged",
      pullable: true,
    });
  });
  it("a local edit since import is a conflict even when the partner is newer", async () => {
    h.remote.referrals = [remoteRef({ status: "admitted", updated_at: "2026-11-16T12:00:00Z" })];
    h.review = {
      complete: true,
      rows: [reviewRow(content, { ...trusted, receiver_matches: false })],
    };
    expect((await get("referrals")).mismatches[0]).toMatchObject({
      state: "conflict",
      reason: "local_edit",
    });
  });
  it("review helper not installed yet: an explicit error, nothing matched", async () => {
    h.remote.referrals = [remoteRef()];
    h.reviewError = { code: "PGRST202" };
    const r = await get("referrals");
    expect(r.error).toBe(REVIEW_ERROR_TEXT.ownership_unavailable);
    expect(r).toMatchObject({ matched: 0, mismatches: [] });
  });
  it("an incomplete or malformed review result is an error, never a partial comparison", async () => {
    h.remote.referrals = [remoteRef()];
    for (const bad of [
      { complete: false, rows: [] },
      { complete: true },
      { rows: [] },
      [],
      null,
      { complete: true, rows: [{ id: RID, local: "x", provenance: null }] },
      {
        complete: true,
        rows: [
          reviewRow(content, { source_revision: 1, watermark: false, receiver_matches: true }),
        ],
      },
    ]) {
      h.review = bad;
      const r = await get("referrals");
      expect(r.error).toBeTruthy();
      expect(r.mismatches).toEqual([]);
      expect(r.matched).toBe(0);
    }
  });
  it("a local read failure is an error, not an empty side", async () => {
    h.reviewError = { code: "57014", message: "x" };
    h.remote.referrals = [remoteRef()];
    const r = await get("referrals");
    expect(r.error).toBeTruthy();
    expect(r.mismatches).toEqual([]);
  });
  it("classifyReferral mirrors the import's order of checks", () => {
    const tomb = {
      id: RID,
      updated_at: "2026-11-16T10:00:00Z",
      deleted_at: "2026-11-16T10:00:00Z",
    };
    expect(classifyReferral(null, null, tomb)).toMatchObject({
      state: "remote_only",
      pullable: true,
    });
    expect(
      classifyReferral(
        content,
        { source_revision: "2026-11-16T09:00:00Z", watermark: true, receiver_matches: false },
        remoteRef(),
      ),
    ).toMatchObject({ state: "conflict", reason: "watermark_reused" });
    expect(classifyReferral(null, trusted, remoteRef())).toMatchObject({
      state: "conflict",
      reason: "local_missing",
    });
    expect(classifyReferral(null, null, null)).toBeNull();
  });
});

describe("bounded local reads", () => {
  it("a REST row cap below the limit no longer looks complete: every page is read", async () => {
    h.maxRows = 300; // the server silently caps each response
    h.local.notifications = ids(1200, "n");
    h.remote.notifications = { records: ids(1200, "n"), complete: true };
    const r = await get("notifications");
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ localCount: 1200, matched: 1200, mismatches: [] });
  });
  it("a capped read over the review limit is refused, not reported as 'only on partner'", async () => {
    h.maxRows = 1000;
    h.local.audit_log = ids(LOCAL_REVIEW_LIMIT + 1, "a");
    const r = await get("audit_log");
    expect(r.error).toBe(REVIEW_ERROR_TEXT.local_truncated);
    expect(r).toMatchObject({ matched: 0, mismatches: [] });
  });
  it("a row cap so small the page budget can't reach the limit is refused", async () => {
    h.maxRows = 50;
    h.local.notifications = ids(3000, "n");
    expect((await get("notifications")).error).toBe(REVIEW_ERROR_TEXT.local_truncated);
  });
  it("a server that repeats a page (no progress) is an error", async () => {
    const stuck = {
      from: () => {
        const b = {
          select: () => b,
          order: () => b,
          gt: () => b,
          limit: async () => ({ data: [{ id: "a" }], error: null }),
        };
        return b;
      },
    };
    await expect(readLocalBounded(stuck, "notifications", "id")).rejects.toThrow(
      "local_read_failed",
    );
  });
  it("a local read failure is an error", async () => {
    h.local.notifications = "error";
    const r = await get("notifications");
    expect(r.error).toBeTruthy();
    expect(r.mismatches).toEqual([]);
  });
});

describe("review-only feeds", () => {
  it("a possibly truncated partner feed is an error, never 'matched' or 'local only'", async () => {
    h.remote.audit = new BridgeFetchError("review_truncated");
    h.local.audit_log = [{ id: "a1" }];
    const r = await get("audit_log");
    expect(r.error).toBeTruthy();
    expect(r.mismatches).toEqual([]);
    expect(r.matched).toBe(0);
  });
  it("an unproven partner list can't say 'only here'", async () => {
    h.remote.notifications = {
      records: [{ id: "n2", created_at: "2026-11-16T09:00:00Z" }],
      complete: false,
    };
    h.local.notifications = [{ id: "n1", kind: "k", created_at: "2026-11-16T09:00:00Z" }];
    const r = await get("notifications");
    expect(r.partnerListComplete).toBe(false);
    expect(r.mismatches.find((m) => m.id === "n1")).toMatchObject({
      state: "local_only",
      reason: "partner_list_unconfirmed",
      pullable: false,
    });
  });
  it("notification message text is never read for the review", async () => {
    await get("notifications");
    const c = h.calls.find((x) => x.table === "notifications")!;
    expect(c.columns).not.toMatch(/message/);
  });
});
