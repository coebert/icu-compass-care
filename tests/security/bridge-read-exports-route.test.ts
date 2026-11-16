import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Partner clinical READ feeds, real route handlers in-process. The database is
 * an in-memory spy: the only clinical read allowed is the single gated SQL
 * export (staged 0008); any direct table read of a clinical table fails the
 * test. Nothing reaches the live backend.
 */
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: null as null | ((t: string) => unknown),
  tableReads: [] as string[],
  syncLogs: [] as unknown[],
  errors: [] as unknown[][],
}));

vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: (t: string) => {
      if (h.from) return h.from(t);
      h.tableReads.push(t);
      throw new Error(`direct read of ${t}`);
    },
  }),
}));
vi.mock("@/lib/api-bridge.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api-bridge.server")>();
  return {
    ...real,
    authorizeBridge: async () => ({
      ok: true,
      actor: { role: "clinician", email: "t@synthetic" },
      signature: "sig",
    }),
    logSync: async (_a: unknown, e: unknown) => void h.syncLogs.push(e),
  };
});

type Handler = (ctx: { request: Request }) => Promise<Response>;
async function get(route: string, query = ""): Promise<Response> {
  const mod = await import(`@/routes/api/public/bridge.${route}.ts`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (mod.Route as any).options.server.handlers.GET as Handler;
  return fn({ request: new Request(`https://hub.example/api/public/bridge/${route}${query}`) });
}

const FEEDS = [
  ["investigations", "investigations", "bridge_export_investigations"],
  ["microbiology", "microbiology", "bridge_export_microbiology"],
  ["referrals", "referrals", "bridge_export_referrals"],
  ["notifications", "notifications", "bridge_export_notifications"],
  ["audit", "audit_log", "bridge_export_audit"],
] as const;
const PID = "20000000-0000-4000-8000-000000000001";

beforeEach(() => {
  h.rpc.mockReset();
  h.tableReads = [];
  h.syncLogs = [];
  h.errors = [];
  h.from = null;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void h.errors.push(a));
});

describe.each(FEEDS)("GET /bridge/%s", (route, key, fn) => {
  it("reads only through the gated SQL export and keeps the response key", async () => {
    const row = { id: "x1", synthetic: true };
    h.rpc.mockResolvedValue({ data: [row], error: null });
    const res = await get(route);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ [key]: [row] });
    expect(h.rpc.mock.calls[0]![0]).toBe(fn);
    expect(h.tableReads).toEqual([]);
  });
  it("empty success is an empty list", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    const res = await get(route);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ [key]: [] });
  });
  it("missing bridge unit (PT503) is unavailable, never empty", async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT503", message: "bridge_unit_unavailable SYNTHETIC-SECRET" },
    });
    const res = await get(route);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "Service unavailable" });
    expect(JSON.stringify(h.errors)).not.toContain("SYNTHETIC-SECRET");
    expect(h.syncLogs).toEqual([]);
  });
  it("query failure, exception, missing function or malformed result is unavailable", async () => {
    for (const r of [
      () => Promise.resolve({ data: null, error: { code: "57014", message: "J.D. 1234567" } }),
      () => Promise.resolve({ data: null, error: { code: "PGRST202" } }),
      () => Promise.reject(new Error("network J.D.")),
      () => Promise.resolve({ data: { not: "a list" }, error: null }),
      () => Promise.resolve({ data: [null], error: null }),
    ]) {
      h.rpc.mockImplementationOnce(r);
      const res = await get(route);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Service unavailable" });
    }
    expect(JSON.stringify(h.errors)).not.toMatch(/J\.D\.|1234567/);
  });
});

describe("GET /bridge/investigations filters", () => {
  it("passes patient and category filters to the gated export", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    await get("investigations", `?patient_id=${PID}&category=bloods`);
    expect(h.rpc).toHaveBeenCalledWith("bridge_export_investigations", {
      _patient_id: PID,
      _category: "bloods",
    });
  });
  it("no filters are passed as null (all shared Radnor patients)", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    await get("investigations");
    expect(h.rpc).toHaveBeenCalledWith("bridge_export_investigations", {
      _patient_id: null,
      _category: null,
    });
  });
  it("a non-UUID patient id matches nothing without querying", async () => {
    const res = await get("investigations", "?patient_id=not-a-uuid");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ investigations: [] });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

vi.mock("@/lib/patient-crypto.server", () => ({
  decryptPatientRows: (r: unknown[] | null) => r ?? [],
}));

describe("GET /bridge/bed_transfers_out", () => {
  const builder = (filters: unknown[][], result: { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"])
      b[m] = (...a: unknown[]) => (filters.push([m, ...a]), b);
    b.maybeSingle = async () => result;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return b;
  };
  it("reads only shared patients of the bridge unit, in one statement", async () => {
    const unitF: unknown[][] = [];
    const patF: unknown[][] = [];
    h.from = (t) =>
      t === "icu_units"
        ? builder(unitF, { data: { id: "u-radnor", code: "SDH-RADNOR" }, error: null })
        : builder(patF, { data: [], error: null });
    const res = await get("bed_transfers_out");
    expect(res.status).toBe(200);
    expect(patF).toContainEqual(["eq", "unit_id", "u-radnor"]);
    expect(patF).toContainEqual(["eq", "shared_with_partner", true]);
  });
  it("unit lookup failure is unavailable, never an unscoped list", async () => {
    const patF: unknown[][] = [];
    h.from = (t) =>
      t === "icu_units"
        ? builder([], { data: null, error: { code: "57014" } })
        : builder(patF, { data: [], error: null });
    const res = await get("bed_transfers_out");
    expect(res.status).toBe(503);
    expect(patF).toEqual([]);
  });
});

describe("no broad shared-id helper remains", () => {
  it("no source file defines or uses sharedPatientIds / sharedReferralIds", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
      });
    const hits = walk(join(__dirname, "../../src")).filter((f) =>
      /sharedPatientIds|sharedReferralIds/.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});
