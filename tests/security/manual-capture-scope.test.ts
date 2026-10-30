// Exercises the REAL captureHandoverSnapshot against an in-memory admin client
// that honours .in()/.eq() filters, with synthetic units and patients only.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db: { icu_units: Row[]; patients: Row[]; handover_unit_versions: Row[] } = {
  icu_units: [],
  patients: [],
  handover_unit_versions: [],
};

function builder(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let upsertRow: Row | null = null;
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    in: (k: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[k])), b),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    upsert: (row: Row) => ((upsertRow = row), b),
    single: async () => {
      const rows = db[table];
      const r = upsertRow!;
      const i = rows.findIndex(
        (x) =>
          x["unit_id"] === r["unit_id"] &&
          x["local_date"] === r["local_date"] &&
          x["shift"] === r["shift"],
      );
      const saved = { ...r, id: i >= 0 ? rows[i]!["id"] : `v-${String(r["unit_id"])}` };
      if (i >= 0) rows[i] = saved;
      else rows.push(saved);
      return { data: { id: saved["id"] }, error: null };
    },
    then: (res: (v: unknown) => unknown) =>
      res({ data: db[table].filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return b;
}

vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => ({ from: (t: keyof typeof db) => builder(t) }),
}));
vi.mock("@/lib/patient-crypto.server", () => ({
  decryptPatientRows: (r: Row[] | null) => r ?? [],
}));
vi.mock("@/lib/crypto.server", () => ({ encryptField: (v: string) => `enc(${v.length})` }));

const { captureHandoverSnapshot } = await import("@/lib/handover-snapshot.server");

beforeEach(() => {
  db.icu_units = [
    { id: "uA", code: "A" },
    { id: "uB", code: "B" },
  ];
  db.patients = [
    { id: "p1", unit_id: "uA", status: "admitted" },
    { id: "p2", unit_id: "uB", status: "admitted" },
    { id: "p3", unit_id: "uB", status: "admitted" },
  ];
  db.handover_unit_versions = [
    { id: "old-B", unit_id: "uB", local_date: "2026-10-30", shift: "day", label: "B original" },
  ];
});

const NOW = new Date("2026-10-30T09:00:00Z");

describe("manual handover capture scope", () => {
  it("a unit admin's capture touches only their unit and reports only its counts/ids", async () => {
    const r = await captureHandoverSnapshot({ force: true, now: NOW, unitIds: ["uA"] });
    expect(r.captured).toBe(true);
    expect(r.patient_count).toBe(1);
    expect(r.id).toBe("v-uA");
    const b = db.handover_unit_versions.filter((v) => v["unit_id"] === "uB");
    expect(b).toHaveLength(1);
    expect(b[0]!["label"]).toBe("B original"); // other unit not overwritten
  });
  it("a unit admin with no units captures nothing", async () => {
    const r = await captureHandoverSnapshot({ force: true, now: NOW, unitIds: [] });
    expect(r.captured).toBe(false);
    expect(db.handover_unit_versions).toHaveLength(1);
  });
  it("an unknown/foreign unit id cannot widen the scope", async () => {
    const r = await captureHandoverSnapshot({ force: true, now: NOW, unitIds: ["uZ"] });
    expect(r.captured).toBe(false);
  });
  it("Trust-wide (no unit filter) capture covers every unit", async () => {
    const r = await captureHandoverSnapshot({ force: true, now: NOW });
    expect(r.patient_count).toBe(3);
    expect(new Set(db.handover_unit_versions.map((v) => v["unit_id"]))).toEqual(
      new Set(["uA", "uB"]),
    );
  });
});
