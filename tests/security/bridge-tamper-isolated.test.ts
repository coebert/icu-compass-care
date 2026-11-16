import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

/**
 * Isolated version of tests/bridge-tamper.test.ts.
 *
 * Runs the REAL verify-signature POST handler and the REAL authorize() HMAC
 * check in-process, with a synthetic secret. Only the side effects that would
 * reach the connected live backend (rate-limit rows, security-event rows) are
 * replaced with in-memory spies, so this never touches live data.
 */

const security = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  limiterCalls: 0,
}));

vi.mock("@/lib/admin-db.server", () => ({ getAdmin: async () => ({}) }));
vi.mock("@/lib/api-bridge.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api-bridge.server")>();
  return {
    ...real,
    enforceBridgeRateLimit: async () => {
      security.limiterCalls++;
      return { ok: true };
    },
    logSecurityEvent: async (_admin: unknown, ev: Record<string, unknown>) => {
      security.events.push(ev);
    },
  };
});

const SECRET = "synthetic-test-secret-not-a-real-value";
const ACTOR = JSON.stringify({
  id: "00000000-0000-0000-0000-000000000002",
  email: "t@synthetic",
  role: "clinician",
});

function sign(secret: string, ts: string, actor: string, body: string) {
  return createHmac("sha256", secret).update(`${ts}.${actor}.${body}`).digest("hex");
}

async function post(
  handler: (ctx: { request: Request }) => Promise<Response>,
  h: Record<string, string>,
  body: string,
) {
  const request = new Request("http://isolated.test/api/public/bridge/verify-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...h },
    body,
  });
  const res = await handler({ request });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function loadPost() {
  const mod = await import("@/routes/api/public/bridge.verify-signature");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod.Route as any).options.server.handlers.POST as (ctx: {
    request: Request;
  }) => Promise<Response>;
}

describe("bridge signed-envelope tamper detection (isolated)", () => {
  beforeEach(() => {
    vi.stubEnv("HANDOVER_API_SECRET", SECRET);
    vi.stubEnv("HANDOVER_API_SECRET_PREVIOUS", "");
    security.events.length = 0;
    security.limiterCalls = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts an intact envelope, then rejects the same signature once one body field changes", async () => {
    const POST = await loadPost();
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = { full_name: "Z.Q.", age: 72, hospital_number: "TAMPER-SYNTH" };
    const body = JSON.stringify(payload);
    const signature = sign(SECRET, ts, ACTOR, body);
    const headers = { "x-timestamp": ts, "x-actor": ACTOR, "x-signature": signature };

    const intact = await post(POST, headers, body);
    expect(intact.status).toBe(200);
    expect(intact.json.signature_valid).toBe(true);

    const tampered = await post(POST, headers, JSON.stringify({ ...payload, age: 99 }));
    expect(tampered.status).toBe(401);
    expect(tampered.json.error).toBe("Invalid signature");
    expect(tampered.json.signature_valid).not.toBe(true);

    // Both requests were rate-limited; only the tampered one was logged as a security event.
    expect(security.limiterCalls).toBe(2);
    expect(security.events).toHaveLength(1);
    expect(security.events[0]).toMatchObject({
      event_type: "signature_failure",
      endpoint: "/bridge/verify-signature",
    });
  });

  it("rejects a tampered actor envelope and a signature made with the wrong secret", async () => {
    const POST = await loadPost();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = "{}";
    const sig = sign(SECRET, ts, ACTOR, body);
    const escalated = ACTOR.replace('"clinician"', '"trust_admin"');
    const a = await post(
      POST,
      { "x-timestamp": ts, "x-actor": escalated, "x-signature": sig },
      body,
    );
    expect(a.status).toBe(401);
    expect(a.json.error).toBe("Invalid signature");

    const wrong = sign("some-other-secret", ts, ACTOR, body);
    const b = await post(POST, { "x-timestamp": ts, "x-actor": ACTOR, "x-signature": wrong }, body);
    expect(b.status).toBe(401);
  });

  it("rejects a correctly signed but stale timestamp", async () => {
    const POST = await loadPost();
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const body = "{}";
    const r = await post(
      POST,
      { "x-timestamp": ts, "x-actor": ACTOR, "x-signature": sign(SECRET, ts, ACTOR, body) },
      body,
    );
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("Stale or invalid timestamp");
  });
});
