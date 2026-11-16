import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * The partner HTTP client must not copy the partner's response body into
 * errors (it can contain record values). fetch is stubbed — no network.
 */
import { BridgeFetchError, fetchPartnerPatients } from "@/lib/bridge-client.server";

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

describe("partner client errors carry codes only", () => {
  it("HTTP error", async () => {
    vi.stubGlobal("fetch", async () => new Response(`{"detail":"${SYN_PHI}"}`, { status: 500 }));
    expect(await codeOf(fetchPartnerPatients())).toBe("partner_http_error");
    expect(
      JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls),
    ).not.toContain(SYN_PHI);
  });
  it("network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(SYN_PHI);
    });
    expect(await codeOf(fetchPartnerPatients())).toBe("partner_unreachable");
  });
  it("non-JSON body", async () => {
    vi.stubGlobal("fetch", async () => new Response(`<html>${SYN_PHI}`, { status: 200 }));
    expect(await codeOf(fetchPartnerPatients())).toBe("malformed_response");
  });
  it("missing list", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ patients: null }));
    expect(await codeOf(fetchPartnerPatients())).toBe("malformed_response");
  });
  it("not configured", async () => {
    delete process.env.PARTNER_BRIDGE_URL;
    expect(await codeOf(fetchPartnerPatients())).toBe("not_configured");
  });
});
