import { describe, it, expect, vi } from "vitest";
import { writePatientFieldChanges } from "@/lib/audit";

// Locks the behaviour that the Demographics edit history captures a
// recalculated Devine IBW row whenever height OR sex changes — including
// when a value is cleared (set to null) or corrected (typo fix). The
// audit surface is the only place a clinician can retrospectively verify
// what IBW was used at a given point in time.

function makeClient() {
  const insert = vi.fn().mockResolvedValue({ data: null, error: null });
  return {
    client: { from: vi.fn().mockReturnValue({ insert }) },
    insert,
  };
}

async function run(before: Record<string, unknown>, after: Record<string, unknown>) {
  const { client, insert } = makeClient();
  await writePatientFieldChanges(client, {
    patientId: "00000000-0000-0000-0000-000000000001",
    before,
    after,
    actor: { id: "u1", email: "u1@example.com" },
  });
  const rows: Array<{ field_name: string; old_value: string | null; new_value: string | null }> =
    insert.mock.calls[0]?.[0] ?? [];
  return {
    all: rows,
    ibw: rows.find((r) => r.field_name === "ibw") ?? null,
  };
}

describe("IBW row in demographics history", () => {
  const base = { full_name: "A.B.", age: 40, sex: "male", height_m: 1.75, weight_kg: 70 };

  it("emits a recalculated IBW row when height changes", async () => {
    const { ibw } = await run(base, { ...base, height_m: 1.8 });
    expect(ibw).not.toBeNull();
    expect(ibw!.old_value).toMatch(/kg \(Devine, male\)$/);
    expect(ibw!.new_value).toMatch(/kg \(Devine, male\)$/);
    expect(ibw!.old_value).not.toBe(ibw!.new_value);
  });

  it("emits a recalculated IBW row when sex changes (height unchanged)", async () => {
    const { ibw } = await run(base, { ...base, sex: "female" });
    expect(ibw).not.toBeNull();
    expect(ibw!.old_value).toMatch(/Devine, male/);
    expect(ibw!.new_value).toMatch(/Devine, female/);
  });

  it("emits an IBW row when height is cleared", async () => {
    const { ibw } = await run(base, { ...base, height_m: null });
    expect(ibw).not.toBeNull();
    expect(ibw!.old_value).toMatch(/kg \(Devine, male\)$/);
    expect(ibw!.new_value).toBeNull();
  });

  it("emits an IBW row when height is first entered (corrected from blank)", async () => {
    const { ibw } = await run({ ...base, height_m: null }, base);
    expect(ibw).not.toBeNull();
    expect(ibw!.old_value).toBeNull();
    expect(ibw!.new_value).toMatch(/kg \(Devine, male\)$/);
  });

  it("emits an IBW row when a mistyped height is corrected", async () => {
    // e.g. 1.57 entered by accident, corrected to 1.75.
    const { ibw } = await run({ ...base, height_m: 1.57 }, { ...base, height_m: 1.75 });
    expect(ibw).not.toBeNull();
    expect(ibw!.old_value).not.toBe(ibw!.new_value);
  });

  it("switches to averaged Devine when sex becomes unknown/other", async () => {
    const { ibw } = await run(base, { ...base, sex: "unknown" });
    expect(ibw).not.toBeNull();
    expect(ibw!.old_value).toMatch(/Devine, male/);
    expect(ibw!.new_value).toMatch(/Devine, averaged/);
  });

  it("does NOT emit an IBW row when neither height nor sex changed", async () => {
    const { ibw } = await run(base, { ...base, weight_kg: 80 });
    expect(ibw).toBeNull();
  });

  it("does NOT emit an IBW row when the rounded 1-dp value is unchanged", async () => {
    // A microscopic height tweak that rounds to the same IBW must not
    // pollute the history with a no-op entry.
    const { ibw } = await run(base, { ...base, height_m: 1.7500001 });
    expect(ibw).toBeNull();
  });
});
