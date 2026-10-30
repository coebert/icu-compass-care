import { describe, expect, it } from "vitest";
import { authorizePasswordReset } from "@/lib/roles.server";

const NOW = 1_800_000_000;
const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const TARGET = "00000000-0000-0000-0000-0000000000b2";

function ctx(roles: string[], opts: { amrAge?: number | null; session?: string } = {}) {
  const amrAge = opts.amrAge === undefined ? 60 : opts.amrAge;
  const rows: Record<string, unknown[]> = {
    user_roles: roles.map((role) => ({ role })),
    user_unit_access: [{ unit_id: "unit-a" }],
  };
  const supabase = {
    rpc: async () => ({ data: opts.session ?? "active", error: null }),
    from: (t: string) => ({ select: () => ({ eq: async () => ({ data: rows[t], error: null }) }) }),
  };
  const claims = amrAge === null ? {} : { amr: [{ method: "password", timestamp: NOW - amrAge }] };
  return { supabase, userId: ACTOR, claims };
}

describe("password reset authorisation (server boundary)", () => {
  it("denies a unit administrator, even with fresh reauthentication", async () => {
    await expect(authorizePasswordReset(ctx(["unit_admin"]), TARGET, NOW)).rejects.toThrow(/Trust administrators only/);
  });
  it("denies clinicians and auditors", async () => {
    await expect(authorizePasswordReset(ctx(["clinician"]), TARGET, NOW)).rejects.toThrow(/Forbidden/);
    await expect(authorizePasswordReset(ctx(["auditor"]), TARGET, NOW)).rejects.toThrow(/Forbidden/);
  });
  it("allows a Trust administrator with recent reauthentication", async () => {
    const actor = await authorizePasswordReset(ctx(["trust_admin"]), TARGET, NOW);
    expect(actor.isTrustAdmin).toBe(true);
  });
  it("allows the legacy 'admin' spelling of Trust administrator", async () => {
    await expect(authorizePasswordReset(ctx(["admin"]), TARGET, NOW)).resolves.toBeTruthy();
  });
  it("requires reauthentication within 10 minutes for a Trust administrator", async () => {
    await expect(authorizePasswordReset(ctx(["trust_admin"], { amrAge: 11 * 60 }), TARGET, NOW)).rejects.toThrow(/REAUTH_REQUIRED/);
    await expect(authorizePasswordReset(ctx(["trust_admin"], { amrAge: null }), TARGET, NOW)).rejects.toThrow(/REAUTH_REQUIRED/);
  });
  it("refuses a locked session", async () => {
    await expect(authorizePasswordReset(ctx(["trust_admin"], { session: "locked" }), TARGET, NOW)).rejects.toThrow(/SESSION_LOCKED/);
  });
  it("refuses resetting your own password here", async () => {
    await expect(authorizePasswordReset(ctx(["trust_admin"]), ACTOR, NOW)).rejects.toThrow(/own password/);
  });
});
