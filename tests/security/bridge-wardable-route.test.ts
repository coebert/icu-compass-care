import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Signed partner patient writes, in-process with in-memory spies (no live
 * backend): the generic patient POST now needs the caller's exact version and
 * refuses wardable fields; the fenced wardable endpoint has an exact request
 * and response contract. Database rules themselves are proven in
 * bed-bridge-staged-db.test.ts and the concurrency suite.
 */
const spy = vi.hoisted(() => ({
  updates: [] as Array<{
    id: string;
    unitId: string;
    expectedUpdatedAt: string;
    payload: Record<string, unknown>;
  }>,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: null as unknown, error: null as unknown },
  fresh: true,
}));
const UNIT = "10000000-0000-4000-8000-000000000001";
vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { id: UNIT, code: "SDH-RADNOR" }, error: null }),
    };
    return {
      from: () => q,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        spy.rpc.push({ fn, args });
        return spy.rpcResult;
      },
    };
  },
}));
vi.mock("@/lib/api-bridge.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api-bridge.server")>();
  return {
    ...real,
    authorizeBridge: async () => ({
      ok: true,
      actor: {
        id: "60000000-0000-4000-8000-000000000001",
        role: "clinician",
        email: "t@synthetic",
      },
      signature: "sig",
    }),
    enforceBridgeRateLimit: async () => ({ ok: true }),
    consumeWriteNonce: async () => spy.fresh,
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
  bridgeUpdateSharedPatient: async (_a: unknown, args: (typeof spy.updates)[number]) => {
    spy.updates.push(args);
    return { kind: "updated", before: { id: args.id }, after: { id: args.id, ...args.payload } };
  },
  bridgeInsertInvestigation: async () => ({ kind: "not_found" }),
}));

import {
  parseDesiredRevision,
  parseWardableRequest,
  parseWardableResponse,
  wardableHttp,
} from "@/lib/bridge-wardable";

type Handler = (ctx: { request: Request }) => Promise<Response>;
async function handler(path: "bridge.patients" | "bridge.patients_.wardable"): Promise<Handler> {
  const mod = await import(`@/routes/api/public/${path}.ts`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod.Route as any).options.server.handlers.POST as Handler;
}
const post = async (path: Parameters<typeof handler>[0], body: unknown) =>
  (await handler(path))({
    request: new Request("http://isolated.test/api/public/bridge/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  });

const PID = "00000000-0000-4000-8000-000000000001";
const V = "2026-11-16T10:00:00.123456+00:00";

beforeEach(() => {
  spy.updates.length = 0;
  spy.rpc.length = 0;
  spy.rpcResult = { data: null, error: null };
  spy.fresh = true;
});

describe("generic partner patient POST", () => {
  it("an update by id without expected_updated_at is refused — never a fresh server version", async () => {
    const res = await post("bridge.patients", { id: PID, outstanding_tasks: "x" });
    expect(res.status).toBe(400);
    expect(spy.updates).toHaveLength(0);
  });
  it.each(["yesterday", "2026-11-16 10:00:00", "2026-11-16T10:00:00", "", 1731751200000])(
    "a malformed expected_updated_at (%j) is refused",
    async (v) => {
      const res = await post("bridge.patients", {
        id: PID,
        outstanding_tasks: "x",
        expected_updated_at: v,
      });
      expect(res.status).toBe(400);
      expect(spy.updates).toHaveLength(0);
    },
  );
  it("a partial update without full_name uses exactly the caller's version and the bridge unit", async () => {
    const res = await post("bridge.patients", {
      id: PID,
      outstanding_tasks: "x",
      expected_updated_at: V,
    });
    expect(res.status).toBe(200);
    expect(spy.updates).toHaveLength(1);
    expect(spy.updates[0]).toMatchObject({ id: PID, unitId: UNIT, expectedUpdatedAt: V });
    expect(spy.updates[0]!.payload).toEqual({ outstanding_tasks: "x" });
  });
  it.each(["wardable", "wardable_at", "wardable_by"])(
    "refuses %s (fenced endpoint only)",
    async (k) => {
      const res = await post("bridge.patients", {
        id: PID,
        expected_updated_at: V,
        [k]: k === "wardable" ? true : null,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("wardable_not_accepted");
      expect(spy.updates).toHaveLength(0);
    },
  );
  it("can't move a patient to another unit, change sharing or the id via the payload (dropped, never written)", async () => {
    const other = "10000000-0000-4000-8000-0000000000ff";
    const res = await post("bridge.patients", {
      id: PID,
      expected_updated_at: V,
      outstanding_tasks: "x",
      unit_id: other,
      shared_with_partner: false,
      shared_with_partner_by: PID,
      updated_at: V,
    });
    expect(res.status).toBe(200);
    expect(spy.updates[0]!.unitId).toBe(UNIT);
    expect(spy.updates[0]!.payload).toEqual({ outstanding_tasks: "x" });
  });
  it("a create without a valid name is refused", async () => {
    const res = await post("bridge.patients", { outstanding_tasks: "x" });
    expect(res.status).toBe(400);
  });
});

const W = { id: PID, expected_updated_at: V, wardable: true, desired_revision: "9007199254740993" };

describe("wardable request parsing", () => {
  it("accepts exactly the four agreed keys", () => {
    expect(parseWardableRequest(W)).toEqual(W);
  });
  it.each([
    ["extra key", { ...W, wardable_at: V }],
    ["missing key", { id: PID, expected_updated_at: V, wardable: true }],
    ["numeric revision", { ...W, desired_revision: 5 }],
    ["leading zero", { ...W, desired_revision: "05" }],
    ["zero", { ...W, desired_revision: "0" }],
    ["above bigint", { ...W, desired_revision: "9223372036854775808" }],
    ["exponent", { ...W, desired_revision: "1e3" }],
    ["string boolean", { ...W, wardable: "true" }],
    ["bad version", { ...W, expected_updated_at: "yesterday" }],
    ["bad id", { ...W, id: "x" }],
    ["array", [W]],
  ])("refuses %s", (_n, raw) => {
    expect(parseWardableRequest(raw)).toBeNull();
  });
  it("revision bounds are exact strings, never JS numbers", () => {
    expect(parseDesiredRevision("9223372036854775807")).toBe("9223372036854775807");
    expect(parseDesiredRevision("9007199254740993")).toBe("9007199254740993");
    expect(parseDesiredRevision(9007199254740993)).toBeNull();
  });
});

describe("POST /api/public/bridge/patients/wardable", () => {
  it("passes the revision to the database as the exact string, with the signed actor", async () => {
    spy.rpcResult = {
      data: {
        ok: true,
        status: "applied",
        desired_revision: W.desired_revision,
        patient: { id: PID, wardable: true, wardable_at: V, updated_at: V },
      },
      error: null,
    };
    const res = await post("bridge.patients_.wardable", W);
    expect(res.status).toBe(200);
    expect(spy.rpc[0]).toMatchObject({
      fn: "bridge_set_wardable",
      args: {
        _patient_id: PID,
        _expected_updated_at: V,
        _wardable: true,
        _desired_revision: "9007199254740993",
        _actor: { id: "60000000-0000-4000-8000-000000000001", role: "clinician" },
      },
    });
    expect(await res.json()).toEqual({
      ok: true,
      status: "applied",
      desired_revision: "9007199254740993",
      patient: { id: PID, wardable: true, wardable_at: V, updated_at: V },
    });
  });
  it("a numeric revision in raw JSON is refused before the database", async () => {
    const res = await post(
      "bridge.patients_.wardable",
      `{"id":"${PID}","expected_updated_at":"${V}","wardable":true,"desired_revision":9007199254740993}`,
    );
    expect(res.status).toBe(400);
    expect(spy.rpc).toHaveLength(0);
  });
  it.each(["superseded", "revision_conflict", "intent_conflict", "target_changed"])(
    "%s → 409 with the highest revision and no patient object",
    async (code) => {
      spy.rpcResult = { data: { ok: false, code, desired_revision: "12" }, error: null };
      const res = await post("bridge.patients_.wardable", W);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, code, desired_revision: "12" });
    },
  );
  it("not_found → opaque 404", async () => {
    spy.rpcResult = { data: { ok: false, code: "not_found" }, error: null };
    const res = await post("bridge.patients_.wardable", W);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: "not_found" });
  });
  it("database errors → generic 503 with no detail; malformed results too", async () => {
    spy.rpcResult = { data: null, error: { code: "XX000", message: "secret detail" } };
    let res = await post("bridge.patients_.wardable", W);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret");
    spy.rpcResult = { data: { ok: true, status: "applied", desired_revision: "5" }, error: null };
    res = await post("bridge.patients_.wardable", W);
    expect(res.status).toBe(503);
    spy.rpcResult = { data: { ok: false, code: "superseded", desired_revision: 12 }, error: null };
    res = await post("bridge.patients_.wardable", W);
    expect(res.status).toBe(503);
  });
  it("a replayed signature is refused without calling the database", async () => {
    spy.fresh = false;
    const res = await post("bridge.patients_.wardable", W);
    expect(res.status).toBe(401);
    expect(spy.rpc).toHaveLength(0);
  });
});

describe("wardable response helpers (what the partner implements)", () => {
  it("success requires a complete patient object; wardable_at may be null but not missing", () => {
    const ok = {
      ok: true,
      status: "applied",
      desired_revision: "5",
      patient: { id: PID, wardable: false, wardable_at: null, updated_at: V },
    };
    expect(wardableHttp(ok).status).toBe(200);
    const { wardable_at: _w, ...missing } = ok.patient;
    expect(wardableHttp({ ...ok, patient: missing }).status).toBe(503);
  });
  it("a 409 carrying a patient object, or an unknown code, is not trusted", () => {
    expect(
      parseWardableResponse(409, {
        ok: false,
        code: "superseded",
        desired_revision: "2",
        patient: {},
      }),
    ).toEqual({ ok: false, code: "unknown" });
    expect(parseWardableResponse(409, { ok: false, code: "replay" })).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(
      parseWardableResponse(409, { ok: false, code: "superseded", desired_revision: "2" }),
    ).toEqual({ ok: false, code: "superseded", desired_revision: "2" });
  });
});
