import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Partner write endpoints with oversized input (GHSA-mrhx-c7xc-m3w5).
 * Runs the REAL route handlers in-process; signing, replay-nonce, audit and
 * database calls are in-memory spies, so nothing reaches the live backend.
 */

const spy = vi.hoisted(() => ({
  authorized: 0,
  updates: [] as unknown[],
  inserts: [] as unknown[],
}));

vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => {
    // Only the fixed bridge unit lookup is answered (synthetic id).
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { id: "10000000-0000-4000-8000-000000000001", code: "SDH-RADNOR" }, error: null }),
    };
    return { from: () => q };
  },
}));
vi.mock("@/lib/api-bridge.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api-bridge.server")>();
  return {
    ...real,
    authorizeBridge: async () => {
      spy.authorized++;
      return { ok: true, actor: { role: "clinician", email: "t@synthetic" }, signature: "sig" };
    },
    enforceBridgeRateLimit: async () => ({ ok: true }),
    consumeWriteNonce: async () => true,
    logSync: async () => {},
    logSecurityEvent: async () => {},
  };
});
vi.mock("@/lib/patient-crypto.server", () => ({
  encryptPatientPayload: (r: unknown) => r,
  decryptPatientRow: (r: unknown) => r,
  decryptPatientRows: (r: unknown[] | null) => r ?? [],
}));
vi.mock("@/lib/audit", () => ({ writeAudit: async () => {}, diffFields: () => [] }));
vi.mock("@/lib/bridge-sharing.server", () => ({
  stripSharingFlags: (r: unknown) => r,
  bridgeUpdateSharedPatient: async (
    _a: unknown,
    args: { id: string; payload: Record<string, unknown> },
  ) => {
    spy.updates.push(args);
    return { kind: "updated", before: { id: args.id }, after: { id: args.id, ...args.payload } };
  },
  bridgeInsertInvestigation: async (_a: unknown, row: Record<string, unknown>) => {
    spy.inserts.push(row);
    return { kind: "inserted", row: { id: "00000000-0000-4000-8000-0000000000aa", ...row } };
  },
}));

type Handler = (ctx: { request: Request }) => Promise<Response>;
async function handler(path: "bridge.patients" | "bridge.investigations"): Promise<Handler> {
  const mod = await import(`@/routes/api/public/${path}.ts`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod.Route as any).options.server.handlers.POST as Handler;
}
const req = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://isolated.test/api/public/bridge/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

const PID = "00000000-0000-4000-8000-000000000001";

describe("partner write endpoints refuse oversized input before validation", () => {
  beforeEach(() => {
    spy.authorized = 0;
    spy.updates.length = 0;
    spy.inserts.length = 0;
  });

  it("patients: a body over 2 MB is refused with 413 before signature checks", async () => {
    const POST = await handler("bridge.patients");
    const big = JSON.stringify({ full_name: "Z.Q.", systems_other: "x".repeat(2 * 1024 * 1024) });
    const res = await POST({ request: req(big) });
    expect(res.status).toBe(413);
    expect(spy.authorized).toBe(0);
    expect(spy.updates).toHaveLength(0);
  });

  it("patients: a signed body with a 50,000-item list is refused with 400 and writes nothing", async () => {
    const POST = await handler("bridge.patients");
    const body = JSON.stringify({
      id: PID,
      full_name: "Z.Q.",
      resp_support: new Array(50_000).fill(1),
    });
    const res = await POST({ request: req(body) });
    expect(res.status).toBe(400);
    expect(spy.authorized).toBe(1);
    expect(spy.updates).toHaveLength(0);
  });

  it("patients: a normal signed update still goes through unchanged", async () => {
    const POST = await handler("bridge.patients");
    const body = JSON.stringify({
      id: PID,
      expected_updated_at: "2026-11-16T10:00:00.123456+00:00",
      full_name: "Z.Q.",
      resp_support: ["hfno"],
      sedative_agents: ["propofol"],
    });
    const res = await POST({ request: req(body) });
    expect(res.status).toBe(200);
    expect(spy.updates).toHaveLength(1);
    expect((spy.updates[0] as { id: string }).id).toBe(PID);
    expect((spy.updates[0] as { payload: Record<string, unknown> }).payload).toMatchObject({
      
      full_name: "Z.Q.",
      resp_support: ["hfno"],
      sedative_agents: ["propofol"],
    });
  });

  it("investigations: oversized declared length → 413; oversized nested list → 400; normal → 200", async () => {
    const POST = await handler("bridge.investigations");
    const tooBig = await POST({
      request: req("{}", { "content-length": String(3 * 1024 * 1024) }),
    });
    expect(tooBig.status).toBe(413);
    expect(spy.authorized).toBe(0);

    const nested = await POST({
      request: req(
        JSON.stringify({
          patient_id: PID,
          category: "Bloods",
          findings: "Hb 120",
          extra: new Array(10_000).fill(0),
        }),
      ),
    });
    expect(nested.status).toBe(400);
    expect(spy.inserts).toHaveLength(0);

    const ok = await POST({
      request: req(JSON.stringify({ patient_id: PID, category: "Bloods", findings: "Hb 120" })),
    });
    expect(ok.status).toBe(200);
    expect(spy.inserts).toHaveLength(1);
  });
});
