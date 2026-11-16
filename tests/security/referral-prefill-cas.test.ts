import { describe, it, expect, vi } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * "Confirm prefill" (referral-prefill.server.ts). Synthetic rows in an
 * in-memory client; encryption is a stub. The write, its checks and its audit
 * are one database transaction (apply_referral_prefill, staged 0009), proven
 * on a throwaway database in bed-bridge-staged-db / bed-concurrency tests.
 * Here: the server only ever writes through that function, with the caller's
 * verified identity, and maps every refusal to a "nothing changed" message.
 */
vi.mock("@/lib/crypto.server", () => ({ encryptField: (v: unknown) => `enc(${String(v)})` }));
vi.mock("@/lib/patient-crypto.server", () => ({
  decryptPatientRow: (r: unknown) => r,
}));
const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  reply: { data: null, error: null } as { data: unknown; error: unknown },
}));
vi.mock("@/lib/admin-db.server", () => ({
  getAdmin: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.calls.push({ fn, args });
      return rpc.reply;
    },
    from: () => {
      throw new Error("no direct table writes");
    },
  }),
}));

import {
  applyReferralPrefill,
  PREFILL_NOT_AUTHORISED_MESSAGE,
  PREFILL_UNAVAILABLE_MESSAGE,
} from "@/lib/referral-prefill.server";
import { PREFILL_STALE_MESSAGE, REFERRAL_LINK_REQUIRED_MESSAGE } from "@/lib/referral-prefill";

const PID = "00000000-0000-4000-8000-000000000001";
const RID = "00000000-0000-4000-8000-000000000002";
const patient = (updated_at: string, extra: Record<string, unknown> = {}) => ({
  id: PID,
  updated_at,
  current_admission: null,
  current_management: null,
  tep_in_place: null,
  tep_details: null,
  dnacpr_decision: null,
  dnacpr_details: null,
  // Linked to this referral already (confirmed in Critical Care Connect).
  source_referral_id: RID,
  ...extra,
});
const referral = (updated_at: string | null) => ({
  id: RID,
  updated_at,
  reason_category: "sepsis",
  ceiling_of_care: "full_escalation",
  resus_status: "for_cpr",
  dnacpr_respect: false,
  anticipated_interventions: [],
  allergies: null,
  weight_kg: null,
  admission_urgency: null,
});

function world(opts: {
  patientAt: string | null;
  referralAt?: string | null;
  patientExtra?: Record<string, unknown>;
  reply?: { data: unknown; error: unknown };
}) {
  rpc.calls.length = 0;
  rpc.reply = opts.reply ?? {
    data: { ok: true, applied_fields: [], patient: { ...patient("v2"), current_admission: "x" } },
    error: null,
  };
  return fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "referrals") return { data: referral(opts.referralAt ?? "r1") };
    if (c.table === "patients" && c.op === "select") {
      return { data: opts.patientAt ? patient(opts.patientAt, opts.patientExtra) : null };
    }
    return {};
  });
}
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ctx = (supabase: unknown, claims: Record<string, unknown> = { session_id: SESSION }) => ({
  supabase,
  userId: "u-synthetic",
  claims,
});
const input = (p = "v1", r: string | null = "r1", extra: Record<string, unknown> = {}) => ({
  patient_id: PID,
  referral_id: RID,
  expected_patient_updated_at: p,
  expected_referral_updated_at: r,
  ...extra,
});
const userWrites = (d: ReturnType<typeof world>) => d.calls.filter((c) => c.op !== "select");
const refusal = (code: string) => ({ data: { ok: false, code }, error: null });

describe("referral prefill — one audited database transaction, previewed versions only", () => {
  it("writes only through apply_referral_prefill, with the caller's verified identity", async () => {
    const d = world({ patientAt: "v1" });
    const res = await applyReferralPrefill(ctx(d), input());
    expect(res.applied_fields).toContain("current_admission");
    expect(rpc.calls).toHaveLength(1);
    const { fn, args } = rpc.calls[0]!;
    expect(fn).toBe("apply_referral_prefill");
    expect(args._actor).toBe("u-synthetic");
    expect(args._session_id).toBe(SESSION);
    const req = args._req as Record<string, unknown>;
    expect(req).toMatchObject({
      patient_id: PID,
      referral_id: RID,
      expected_patient_updated_at: "v1",
      expected_referral_updated_at: "r1",
    });
    // Sealed text only; never a link, unit, sharing flag or actor in the request.
    const set = req.set as Record<string, string>;
    expect(Object.keys(set).sort()).toEqual(["current_admission", "tep_details"]);
    expect(set.current_admission!.startsWith("enc(")).toBe(true);
    expect(req).not.toHaveProperty("source_referral_id");
    expect(req).not.toHaveProperty("dnacpr_decision");
    // No separate after-the-fact patient update or audit write.
    expect(userWrites(d)).toHaveLength(0);
  });

  it("an explicitly ticked decision is passed for the database to re-check", async () => {
    const d = world({ patientAt: "v1" });
    await applyReferralPrefill(
      ctx(d),
      input("v1", "r1", { accept_decisions: ["dnacpr_decision"] }),
    );
    expect((rpc.calls[0]!.args._req as Record<string, unknown>).dnacpr_decision).toBe(false);
  });

  it("refuses a stale preview seen at read time; no write attempted", async () => {
    const d = world({ patientAt: "v9" });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(PREFILL_STALE_MESSAGE);
    const d2 = world({ patientAt: "v1", referralAt: "r2" });
    await expect(applyReferralPrefill(ctx(d2), input())).rejects.toThrow(PREFILL_STALE_MESSAGE);
    expect(rpc.calls).toHaveLength(0);
  });

  it.each([
    ["stale", PREFILL_STALE_MESSAGE],
    ["link_required", REFERRAL_LINK_REQUIRED_MESSAGE],
    ["not_found", "Patient not found"],
    ["referral_unavailable", "Referral not found"],
    ["not_authorised", PREFILL_NOT_AUTHORISED_MESSAGE],
    ["something_new", PREFILL_STALE_MESSAGE],
  ])(
    "a concurrent change refused in the transaction (%s) is reported, not applied",
    async (code, msg) => {
      const d = world({ patientAt: "v1", reply: refusal(code) });
      await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(msg);
      expect(userWrites(d)).toHaveLength(0);
    },
  );

  it("fails closed when the staged function is not installed yet", async () => {
    const d = world({
      patientAt: "v1",
      reply: { data: null, error: { code: "PGRST202", message: "x" } },
    });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(
      PREFILL_UNAVAILABLE_MESSAGE,
    );
  });

  it("refuses without a session id in the verified token", async () => {
    const d = world({ patientAt: "v1" });
    await expect(applyReferralPrefill(ctx(d, {}), input())).rejects.toThrow(
      PREFILL_NOT_AUTHORISED_MESSAGE,
    );
    expect(rpc.calls).toHaveLength(0);
  });

  it("asks to fill only blank fields", async () => {
    const d = world({
      patientAt: "v1",
      patientExtra: { current_admission: "Existing synthetic text" },
    });
    const res = await applyReferralPrefill(ctx(d), input());
    expect(res.skipped_fields).toContain("current_admission");
    expect(rpc.calls[0]!.args._req).toMatchObject({ set: { tep_details: expect.any(String) } });
    expect((rpc.calls[0]!.args._req as { set: object }).set).not.toHaveProperty(
      "current_admission",
    );
  });

  it("refuses an unlinked or differently linked patient without writing", async () => {
    for (const link of [null, "00000000-0000-4000-8000-0000000000ff"]) {
      const d = world({ patientAt: "v1", patientExtra: { source_referral_id: link } });
      await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(
        REFERRAL_LINK_REQUIRED_MESSAGE,
      );
    }
    expect(rpc.calls).toHaveLength(0);
  });

  it("nothing blank to fill: no write at all", async () => {
    const d = world({
      patientAt: "v1",
      patientExtra: {
        current_admission: "a",
        current_management: "b",
        tep_details: "c",
        dnacpr_details: "d",
        dnacpr_decision: false,
      },
    });
    const res = await applyReferralPrefill(ctx(d), input());
    expect(res.applied_fields).toEqual([]);
    expect(rpc.calls).toHaveLength(0);
  });
});
