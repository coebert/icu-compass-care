import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePartnerBase } from "@/lib/partner-url";
import { partnerReferralUrl } from "@/lib/referral-prefill";
import { fetchSyncV1, BridgeFetchError } from "@/lib/bridge-client.server";
import { corsHeaders } from "@/lib/api-bridge.server";

const RID = "11111111-2222-4333-8444-555555555555";
const CCC = "https://critical-care-flow.lovable.app";

describe("partner base URL validation", () => {
  it("accepts the bare partner origin, with or without a trailing slash", () => {
    expect(parsePartnerBase(CCC)).toEqual({ ok: true, origin: CCC });
    expect(parsePartnerBase(`${CCC}/`)).toEqual({ ok: true, origin: CCC });
  });
  it("rejects this app's own published and project-id hosts as self", () => {
    for (const u of [
      "https://icu-compass-care.lovable.app",
      "https://ICU-Compass-Care.lovable.app/",
      "https://project--58df96bd-2803-4146-90a7-4a08f526bece.lovable.app",
      "https://id-preview--58df96bd-2803-4146-90a7-4a08f526bece.lovable.app",
    ]) {
      expect(parsePartnerBase(u)).toEqual({ ok: false, reason: "self" });
    }
  });
  it("rejects a path, query, credentials or non-https instead of doubling paths", () => {
    for (const u of [
      `${CCC}/api/public/bridge`,
      `${CCC}/?x=1`,
      "https://user:pw@critical-care-flow.lovable.app",
      "http://critical-care-flow.lovable.app",
      "not a url",
    ]) {
      expect(parsePartnerBase(u)).toEqual({ ok: false, reason: "invalid" });
    }
  });
  it("missing is distinct from invalid", () => {
    expect(parsePartnerBase(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(parsePartnerBase("  ")).toEqual({ ok: false, reason: "missing" });
  });
  it("referral links never point back at this app", () => {
    expect(partnerReferralUrl("https://icu-compass-care.lovable.app", RID)).toBeNull();
    expect(partnerReferralUrl(CCC, RID)).toBe(`${CCC}/referrals/${RID}`);
  });
});

describe("sync client refuses a self-pointing partner URL", () => {
  const env = { ...process.env };
  const fetchSpy = vi.fn();
  beforeEach(() => {
    process.env.HANDOVER_API_SECRET = "synthetic-secret";
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return "resolved";
    } catch (e) {
      return e instanceof BridgeFetchError ? e.code : "other";
    }
  };
  it("self URL: coded failure and no signed request is sent", async () => {
    process.env.PARTNER_BRIDGE_URL = "https://icu-compass-care.lovable.app";
    expect(await codeOf(fetchSyncV1("referrals"))).toBe("partner_url_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("URL with a path: coded failure and no request", async () => {
    process.env.PARTNER_BRIDGE_URL = `${CCC}/api/public/bridge`;
    expect(await codeOf(fetchSyncV1("investigations"))).toBe("partner_url_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("valid origin builds exactly origin + /api/public/bridge/<resource>?sync=1&limit=500", async () => {
    process.env.PARTNER_BRIDGE_URL = `${CCC}/`;
    fetchSpy.mockResolvedValue(
      Response.json({
        schema_version: 1,
        records: [],
        snapshot_at: "2026-11-16T10:00:00.000Z",
        pagination: { next_cursor: null, complete: true },
      }),
    );
    await fetchSyncV1("microbiology");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `${CCC}/api/public/bridge/microbiology?sync=1&limit=500`,
    );
  });
  it("CORS grants nothing to a self-pointing value", () => {
    process.env.PARTNER_BRIDGE_URL = "https://icu-compass-care.lovable.app";
    expect(corsHeaders()["Access-Control-Allow-Origin"]).toBe("null");
    process.env.PARTNER_BRIDGE_URL = CCC;
    expect(corsHeaders()["Access-Control-Allow-Origin"]).toBe(CCC);
  });
});
