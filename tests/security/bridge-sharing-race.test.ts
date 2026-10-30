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

const base = (): Row => ({
  id: "p1",
  unit_id: "uA",
  shared_with_partner: true,
  updated_at: "t0",
  bed: "1",
});

describe("bridge patient update respects partner sharing", () => {
  it("updates a shared patient at the expected version", async () => {
    const rows = [base()];
    const r = await bridgeUpdateSharedPatient(fakeAdmin(rows), {
      id: "p1",
      expectedUpdatedAt: "t0",
      payload: { bed: "2" },
    });
    expect(r.kind).toBe("updated");
    expect(rows[0]!["bed"]).toBe("2");
  });

  it("a never-shared patient is not found and unchanged", async () => {
    const rows = [{ ...base(), shared_with_partner: false }];
    const r = await bridgeUpdateSharedPatient(fakeAdmin(rows), { id: "p1", payload: { bed: "2" } });
    expect(r.kind).toBe("not_found");
    expect(rows[0]!["bed"]).toBe("1");
  });

  it("a formerly-shared patient with a stale version returns not_found, never a clinical conflict payload", async () => {
    const rows = [{ ...base(), shared_with_partner: false, updated_at: "t9" }];
    const r = await bridgeUpdateSharedPatient(fakeAdmin(rows), {
      id: "p1",
      expectedUpdatedAt: "t0",
      payload: { bed: "2" },
    });
    expect(r).toEqual({ kind: "not_found" });
  });

  it("sharing revoked between the read and the write: no write, not_found", async () => {
    const rows = [base()];
    const admin = fakeAdmin(rows, {
      beforeUpdate: () => {
        rows[0]!["shared_with_partner"] = false;
      },
    });
    const r = await bridgeUpdateSharedPatient(admin, {
      id: "p1",
      expectedUpdatedAt: "t0",
      payload: { bed: "2" },
    });
    expect(r).toEqual({ kind: "not_found" });
    expect(rows[0]!["bed"]).toBe("1");
  });

  it("a concurrent clinical edit between read and write yields a conflict, not an overwrite", async () => {
    const rows = [base()];
    const admin = fakeAdmin(rows, {
      beforeUpdate: () => {
        rows[0]!["updated_at"] = "t1";
      },
    });
    const r = await bridgeUpdateSharedPatient(admin, {
      id: "p1",
      expectedUpdatedAt: "t0",
      payload: { bed: "2" },
    });
    expect(r.kind).toBe("conflict");
    expect(rows[0]!["bed"]).toBe("1");
  });

  it("a unit move between read and write blocks the write", async () => {
    const rows = [base()];
    const admin = fakeAdmin(rows, {
      beforeUpdate: () => {
        rows[0]!["unit_id"] = "uB";
      },
    });
    const r = await bridgeUpdateSharedPatient(admin, { id: "p1", payload: { bed: "2" } });
    expect(r.kind).not.toBe("updated");
    expect(rows[0]!["bed"]).toBe("1");
  });

  it("the partner cannot change sharing flags or unit", async () => {
    const rows = [base()];
    await bridgeUpdateSharedPatient(fakeAdmin(rows), {
      id: "p1",
      payload: { shared_with_partner: false, unit_id: "uB", bed: "3" },
    });
    expect(rows[0]!["unit_id"]).toBe("uA");
    expect(rows[0]!["shared_with_partner"]).toBe(true);
    expect(rows[0]!["bed"]).toBe("3");
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
