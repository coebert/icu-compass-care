import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/admin-db.server", () => ({ getAdmin: async () => ({}) }));
const mod = await import("@/lib/schema-validation.server");
const { validateSchema, __resetSchemaCache, nextBackoffMs, SUCCESS_TTL_MS } = mod;

const ok = { ok: true, problems: [], checkedAt: "x" };
const bad = { ok: false, problems: [{ table: "t", kind: "missing_table" as const, detail: "d" }], checkedAt: "x" };

beforeEach(() => __resetSchemaCache());

describe("schema diagnostics caching", () => {
  it("coalesces concurrent callers into one probe", async () => {
    const run = vi.fn(async () => ok);
    await Promise.all(Array.from({ length: 20 }, () => validateSchema(false, { run })));
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("caches success for the TTL, even when 'force' is requested", async () => {
    let t = 0;
    const run = vi.fn(async () => ok);
    await validateSchema(false, { run, now: () => t });
    t = SUCCESS_TTL_MS - 1;
    await validateSchema(true, { run, now: () => t });
    expect(run).toHaveBeenCalledTimes(1);
    t = SUCCESS_TTL_MS + 1;
    await validateSchema(false, { run, now: () => t });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("caches failures with exponential backoff instead of re-probing every request", async () => {
    let t = 0;
    const run = vi.fn(async () => bad);
    for (let i = 0; i < 50; i++) await validateSchema(false, { run, now: () => t });
    expect(run).toHaveBeenCalledTimes(1);
    t = nextBackoffMs(1) + 1;
    await validateSchema(false, { run, now: () => t });
    expect(run).toHaveBeenCalledTimes(2);
    expect(nextBackoffMs(2)).toBeGreaterThan(nextBackoffMs(1));
    expect(nextBackoffMs(99)).toBe(10 * 60 * 1000);
  });
  it("transient errors (thrown) are cached with backoff and do not block the app", async () => {
    const run = vi.fn(async () => Promise.reject(new Error("521")));
    const r = await validateSchema(false, { run, now: () => 0 });
    expect(r.ok).toBe(true);
    await validateSchema(false, { run, now: () => 1000 });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
