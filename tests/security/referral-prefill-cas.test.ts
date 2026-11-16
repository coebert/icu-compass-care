import { describe, it, expect, vi } from "vitest";
import { fakeSupabase, hasFilter, type FakeCall, type FakeResult } from "../support/fake-supabase";

/**
 * "Confirm prefill" compare-and-set (referral-prefill.server.ts). Synthetic
 * rows in an in-memory client; audit and encryption are stubs.
 */
vi.mock("@/lib/crypto.server", () => ({ encryptField: (v: unknown) => v }));
vi.mock("@/lib/patient-crypto.server", () => ({
  PATIENT_ENCRYPTED_FIELDS: [],
  decryptPatientRow: (r: unknown) => r,
  encryptPatientPayload: (r: unknown) => r,
}));
vi.mock("@/lib/audit", () => ({
  writeAudit: async () => {},
  writePatientFieldChanges: async () => {},
  diffFields: () => [],
}));
vi.mock("@/lib/admin-db.server", () => ({ getAdmin: async () => ({}) }));

import { applyReferralPrefill } from "@/lib/referral-prefill.server";
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
  updateMatches?: boolean;
  stillExists?: boolean;
  stillLinkedTo?: string | null;
  patientExtra?: Record<string, unknown>;
}) {
  let reads = 0;
  return fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "referrals") return { data: referral(opts.referralAt ?? "r1") };
    if (c.table === "patients" && c.op === "update") {
      return opts.updateMatches === false
        ? { data: null }
        : { data: { ...patient("v2"), ...(c.payload as object) } };
    }
    if (c.table === "patients" && c.op === "select") {
      reads++;
      if (reads > 1)
        return {
          data:
            opts.stillExists === false
              ? null
              : { id: PID, source_referral_id: opts.stillLinkedTo === undefined ? RID : opts.stillLinkedTo },
        };
      return { data: opts.patientAt ? patient(opts.patientAt, opts.patientExtra) : null };
    }
    return {};
  });
}
const ctx = (supabase: unknown) => ({ supabase, userId: "u-synthetic", claims: {} });
const input = (p = "v1", r: string | null = "r1") => ({
  patient_id: PID,
  referral_id: RID,
  expected_patient_updated_at: p,
  expected_referral_updated_at: r,
});
const updates = (d: ReturnType<typeof world>) => d.calls.filter((c) => c.op === "update");

describe("referral prefill — compare-and-set against the previewed version", () => {
  it("applies when patient and referral are the previewed versions, guarded by updated_at", async () => {
    const d = world({ patientAt: "v1" });
    const res = await applyReferralPrefill(ctx(d), input());
    expect(res.applied_fields).toContain("current_admission");
    const up = updates(d)[0];
    expect(hasFilter(up, "eq", "updated_at", "v1")).toBe(true);
    expect(hasFilter(up, "eq", "id", PID)).toBe(true);
    // The link is part of the atomic write, and never set by this action.
    expect(hasFilter(up, "eq", "source_referral_id", RID)).toBe(true);
    expect(up.payload as Record<string, unknown>).not.toHaveProperty("source_referral_id");
  });

  it("refuses a stale preview when the patient was edited after preview; writes nothing", async () => {
    const d = world({ patientAt: "v9" });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(PREFILL_STALE_MESSAGE);
    expect(updates(d)).toHaveLength(0);
  });

  it("refuses when a concurrent edit lands between the read and the write", async () => {
    const d = world({ patientAt: "v1", updateMatches: false });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(PREFILL_STALE_MESSAGE);
  });

  it("refuses when the referral re-synced after preview", async () => {
    const d = world({ patientAt: "v1", referralAt: "r2" });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(PREFILL_STALE_MESSAGE);
    expect(updates(d)).toHaveLength(0);
  });

  it("reports not found (not stale) when the row is no longer visible to the caller", async () => {
    const d = world({ patientAt: "v1", updateMatches: false, stillExists: false });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow("Patient not found");
  });

  it("still fills only blank fields", async () => {
    const d = world({
      patientAt: "v1",
      patientExtra: { current_admission: "Existing synthetic text" },
    });
    const res = await applyReferralPrefill(ctx(d), input());
    expect(res.applied_fields).not.toContain("current_admission");
    expect(res.skipped_fields).toContain("current_admission");
    expect((updates(d)[0].payload as Record<string, unknown>).current_admission).toBeUndefined();
  });

  it("refuses an unlinked patient without writing anything", async () => {
    const d = world({ patientAt: "v1", patientExtra: { source_referral_id: null } });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(REFERRAL_LINK_REQUIRED_MESSAGE);
    expect(updates(d)).toHaveLength(0);
  });

  it("refuses a patient linked to a different referral", async () => {
    const d = world({ patientAt: "v1", patientExtra: { source_referral_id: "00000000-0000-4000-8000-0000000000ff" } });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(REFERRAL_LINK_REQUIRED_MESSAGE);
    expect(updates(d)).toHaveLength(0);
  });

  it("a link change between the read and the write is reported as a link problem, not applied", async () => {
    const d = world({ patientAt: "v1", updateMatches: false, stillLinkedTo: null });
    await expect(applyReferralPrefill(ctx(d), input())).rejects.toThrow(REFERRAL_LINK_REQUIRED_MESSAGE);
  });

  it("nothing blank to fill: no write at all", async () => {
    const d = world({
      patientAt: "v1",
      patientExtra: {
        current_admission: "a", current_management: "b", tep_details: "c", dnacpr_details: "d", dnacpr_decision: false,
      },
    });
    const res = await applyReferralPrefill(ctx(d), input());
    expect(res.applied_fields).toEqual([]);
    expect(updates(d)).toHaveLength(0);
  });
});
