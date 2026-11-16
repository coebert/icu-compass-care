// Exercises the REAL bridgeUpdateSharedPatient compare-and-set logic against an
// in-memory table that honours every .eq() filter, so sharing revocation and
// concurrent edits between the read and the write are simulated faithfully.
import { describe, expect, it } from "vitest";
import { bridgeUpdateSharedPatient } from "@/lib/bridge-sharing.server";
import { challengeIsValid } from "@/lib/passkey-policy";

type Row = Record<string, unknown>;

function fakeAdmin(rows: Row[], hooks: { beforeUpdate?: () => void } = {}) {
  return {
    from() {
      const filters: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      const match = (r: Row) => filters.every(([k, v]) => r[k] === v);
      const b = {
        select() {
          return b;
        },
        update(p: Row) {
          patch = p;
          return b;
        },
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return b;
        },
        async maybeSingle() {
          if (patch) {
            hooks.beforeUpdate?.();
            const hit = rows.find(match);
            if (!hit) return { data: null, error: null };
            Object.assign(hit, patch, { updated_at: `${hit["updated_at"]}+1` });
            return { data: { ...hit }, error: null };
          }
          const hit = rows.find(match);
          return { data: hit ? { ...hit } : null, error: null };
        },
      };
      return b;
    },
  };
}

const T0 = "2026-11-16T10:00:00.000001+00:00";
const T1 = "2026-11-16T10:00:00.000002+00:00";
const base = (): Row => ({
  id: "p1",
  unit_id: "uA",
  shared_with_partner: true,
  updated_at: T0,
  outstanding_tasks: "a",
});
const upd = (rows: Row[], over: Record<string, unknown> = {}, hooks: { beforeUpdate?: () => void } = {}) =>
  bridgeUpdateSharedPatient(fakeAdmin(rows, hooks), {
    id: "p1",
    unitId: "uA",
    expectedUpdatedAt: T0,
    payload: { outstanding_tasks: "b" },
    ...over,
  });

describe("bridge patient update respects partner sharing", () => {
  it("updates a shared patient at the expected version", async () => {
    const rows = [base()];
    const r = await upd(rows);
    expect(r.kind).toBe("updated");
    expect(rows[0]!["outstanding_tasks"]).toBe("b");
  });

  it("the same instant in another textual form still matches (microsecond-exact)", async () => {
    const rows = [base()];
    expect((await upd(rows, { expectedUpdatedAt: "2026-11-16T10:00:00.000001Z" })).kind).toBe("updated");
  });

  it("a missing or malformed expected version is refused; nothing is read or written", async () => {
    for (const v of ["", "yesterday", undefined]) {
      const rows = [base()];
      const r = await upd(rows, { expectedUpdatedAt: v as unknown as string });
      expect(r.kind).toBe("error");
      expect(rows[0]!["outstanding_tasks"]).toBe("a");
    }
  });

  it("a stale expected version is a conflict, not an overwrite", async () => {
    const rows = [{ ...base(), updated_at: T1 }];
    const r = await upd(rows);
    expect(r.kind).toBe("conflict");
    expect(rows[0]!["outstanding_tasks"]).toBe("a");
  });

  it("a never-shared patient is not found and unchanged", async () => {
    const rows = [{ ...base(), shared_with_partner: false }];
    expect((await upd(rows)).kind).toBe("not_found");
    expect(rows[0]!["outstanding_tasks"]).toBe("a");
  });

  it("a patient in another unit is not found and unchanged", async () => {
    const rows = [{ ...base(), unit_id: "uB" }];
    expect((await upd(rows)).kind).toBe("not_found");
  });

  it("a formerly-shared patient with a stale version returns not_found, never a clinical conflict payload", async () => {
    const rows = [{ ...base(), shared_with_partner: false, updated_at: T1 }];
    expect(await upd(rows)).toEqual({ kind: "not_found" });
  });

  it("sharing revoked between the read and the write: no write, not_found", async () => {
    const rows = [base()];
    const r = await upd(rows, {}, { beforeUpdate: () => void (rows[0]!["shared_with_partner"] = false) });
    expect(r).toEqual({ kind: "not_found" });
    expect(rows[0]!["outstanding_tasks"]).toBe("a");
  });

  it("a concurrent clinical edit between read and write yields a conflict, not an overwrite", async () => {
    const rows = [base()];
    const r = await upd(rows, {}, { beforeUpdate: () => void (rows[0]!["updated_at"] = T1) });
    expect(r.kind).toBe("conflict");
    expect(rows[0]!["outstanding_tasks"]).toBe("a");
  });

  it("a unit move between read and write blocks the write", async () => {
    const rows = [base()];
    const r = await upd(rows, {}, { beforeUpdate: () => void (rows[0]!["unit_id"] = "uB") });
    expect(r.kind).not.toBe("updated");
    expect(rows[0]!["outstanding_tasks"]).toBe("a");
  });

  it("the partner cannot change sharing flags, unit or id", async () => {
    const rows = [base()];
    await upd(rows, { payload: { shared_with_partner: false, unit_id: "uB", id: "p2", outstanding_tasks: "c" } });
    expect(rows[0]).toMatchObject({ id: "p1", unit_id: "uA", shared_with_partner: true, outstanding_tasks: "c" });
  });
});

describe("passkey challenge binding", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const row = {
    challenge: "c",
    purpose: "authentication",
    session_id: "s1",
    expires_at: "2026-10-30T12:04:00Z",
  };
  it("accepts only the same session, purpose and an unexpired challenge", () => {
    expect(challengeIsValid(row, { sessionId: "s1", purpose: "authentication" }, now)).toBe(true);
    expect(challengeIsValid(row, { sessionId: "s2", purpose: "authentication" }, now)).toBe(false);
    expect(challengeIsValid(row, { sessionId: "s1", purpose: "registration" }, now)).toBe(false);
    expect(
      challengeIsValid(
        row,
        { sessionId: "s1", purpose: "authentication" },
        Date.parse("2026-10-30T12:05:00Z"),
      ),
    ).toBe(false);
  });
  it("rejects browser-written challenges with no session binding", () => {
    expect(
      challengeIsValid(
        { ...row, session_id: null },
        { sessionId: "s1", purpose: "authentication" },
        now,
      ),
    ).toBe(false);
  });
});
