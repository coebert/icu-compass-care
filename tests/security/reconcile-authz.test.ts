import { describe, expect, it } from "vitest";
import { assertReconcileAccess } from "@/lib/roles.server";

// The Sync review reads all units' notification/audit metadata and a pull
// writes referrals: Trust administrators only, with an active session.
function ctx(roles: string[], session = "active") {
  const rows: Record<string, unknown[]> = {
    user_roles: roles.map((role) => ({ role })),
    user_unit_access: [{ unit_id: "unit-a" }],
  };
  return {
    supabase: {
      rpc: async () => ({ data: session, error: null }),
      from: (t: string) => ({
        select: () => ({ eq: async () => ({ data: rows[t], error: null }) }),
      }),
    },
    userId: "00000000-0000-0000-0000-0000000000a1",
  };
}

describe("sync review authorisation", () => {
  it("refuses a unit administrator", async () => {
    await expect(assertReconcileAccess(ctx(["unit_admin"]))).rejects.toThrow(/^Forbidden/);
  });
  it("refuses clinicians and auditors", async () => {
    await expect(assertReconcileAccess(ctx(["clinician"]))).rejects.toThrow(/^Forbidden/);
    await expect(assertReconcileAccess(ctx(["auditor"]))).rejects.toThrow(/^Forbidden/);
  });
  it("allows a Trust administrator (and the legacy 'admin' spelling)", async () => {
    await expect(assertReconcileAccess(ctx(["trust_admin"]))).resolves.toMatchObject({
      isTrustAdmin: true,
    });
    await expect(assertReconcileAccess(ctx(["admin"]))).resolves.toMatchObject({
      isTrustAdmin: true,
    });
  });
  it("refuses a locked session even for a Trust administrator", async () => {
    await expect(assertReconcileAccess(ctx(["trust_admin"], "locked"))).rejects.toThrow(
      /^SESSION_LOCKED/,
    );
  });
});
