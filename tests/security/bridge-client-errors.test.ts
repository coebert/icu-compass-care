import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * The partner HTTP client must not copy the partner's response body into
 * errors (it can contain record values). fetch is stubbed — no network.
 */
import {
  BridgeFetchError,
  fetchPartnerAuditLogForReview,
  fetchSyncV1,
  legacyReviewPath,
} from "@/lib/bridge-client.server";

const SYN_PHI = "SYNTHETIC-BODY-ZZ-0001";
const env = { ...process.env };
beforeEach(() => {
  process.env.PARTNER_BRIDGE_URL = "https://partner.invalid";
  process.env.HANDOVER_API_SECRET = "synthetic-test-secret";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "accepted";
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeFetchError);
    expect(String((e as Error).message)).not.toContain(SYN_PHI);
    return (e as BridgeFetchError).code;
  }
}
const SNAP = "2026-11-16T12:00:00Z";
const rid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("partner client errors carry codes only", () => {
  it("HTTP error", async () => {
    vi.stubGlobal("fetch", async () => new Response(`{"detail":"${SYN_PHI}"}`, { status: 500 }));
    expect(await codeOf(fetchSyncV1("referrals"))).toBe("partner_http_error");
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain(SYN_PHI);
  });
  it("network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(SYN_PHI);
    });
    expect(await codeOf(fetchSyncV1("investigations"))).toBe("partner_unreachable");
  });
  it("non-JSON body", async () => {
    vi.stubGlobal("fetch", async () => new Response(`<html>${SYN_PHI}`, { status: 200 }));
    expect(await codeOf(fetchSyncV1("microbiology"))).toBe("malformed_response");
  });
  it("the legacy {records} shape on a sync v1 request is a contract mismatch, not 'no records'", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ records: [] }));
    expect(await codeOf(fetchSyncV1("referrals"))).toBe("contract_mismatch");
  });
  it("not configured", async () => {
    delete process.env.PARTNER_BRIDGE_URL;
    expect(await codeOf(fetchSyncV1("referrals"))).toBe("not_configured");
  });
});

describe("partner client paging", () => {
  it("follows the opaque cursor (encoded) under one snapshot and returns everything", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      urls.push(u);
      const cursor = new URL(u).searchParams.get("cursor");
      if (cursor === null)
        return Response.json({ schema_version: 1, records: [{ id: rid(1), updated_at: "2026-11-16T10:00:00Z" }], snapshot_at: SNAP, pagination: { next_cursor: "a+b/c=", complete: false } });
      expect(cursor).toBe("a+b/c=");
      return Response.json({ schema_version: 1, records: [{ id: rid(2), updated_at: "2026-11-16T10:00:01Z" }], snapshot_at: SNAP, pagination: { next_cursor: null, complete: true } });
    });
    const out = await fetchSyncV1("referrals");
    expect(out.records.map((r) => r.id)).toEqual([rid(1), rid(2)]);
    expect(urls[0]).toContain("/api/public/bridge/referrals?sync=1&limit=500");
  });
  it("a mid-run failure returns nothing at all", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1)
        return Response.json({ schema_version: 1, records: [{ id: rid(1), updated_at: "2026-11-16T10:00:00Z" }], snapshot_at: SNAP, pagination: { next_cursor: "c1", complete: false } });
      return new Response("", { status: 502 });
    });
    expect(await codeOf(fetchSyncV1("referrals"))).toBe("partner_http_error");
  });
});

describe("legacy review feeds", () => {
  it("always ask for an explicit bound", () => {
    expect(legacyReviewPath("audit")).toBe("/api/public/bridge/audit?limit=200");
    expect(legacyReviewPath("notifications")).toBe("/api/public/bridge/notifications?limit=200");
  });
  it("a saturated page without proof of completeness fails instead of looking complete", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ records: Array.from({ length: 200 }, (_, i) => ({ id: `a${i}` })) }));
    expect(await codeOf(fetchPartnerAuditLogForReview())).toBe("review_truncated");
  });
  it("a missing list fails", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ audit: [] }));
    expect(await codeOf(fetchPartnerAuditLogForReview())).toBe("malformed_response");
  });
});
