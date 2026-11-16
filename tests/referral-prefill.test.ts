import { describe, it, expect } from "vitest";
import {
  computeReferralPrefill,
  partnerReferralUrl,
  prefillLinkState,
  REFERRAL_INFO_PREFIX,
  type PatientPrefillTarget,
  type ReferralPrefillSource,
} from "@/lib/referral-prefill";

const blank: PatientPrefillTarget = {
  current_admission: null,
  current_management: null,
  tep_in_place: null,
  tep_details: null,
  dnacpr_decision: null,
  dnacpr_details: null,
};
const ref = (over: Partial<ReferralPrefillSource> = {}): ReferralPrefillSource => ({
  reason_category: "sepsis",
  ceiling_of_care: "no_cpr",
  resus_status: "dnacpr",
  dnacpr_respect: true,
  anticipated_interventions: ["vasopressors", "rrt"],
  allergies: "Penicillin",
  weight_kg: 80,
  admission_urgency: "urgent",
  ...over,
});

describe("computeReferralPrefill", () => {
  it("fills blank text only, labelled as referral information needing review", () => {
    const plan = computeReferralPrefill(ref(), blank);
    for (const f of ["current_admission", "current_management", "tep_details", "dnacpr_details"]) {
      expect(String(plan.patch[f])).toContain(REFERRAL_INFO_PREFIX);
    }
    expect(String(plan.patch.current_management)).toContain("Vasopressors");
    expect(String(plan.patch.current_management)).toContain("Penicillin");
    expect(String(plan.patch.tep_details)).toContain("Not a completed TEP");
  });

  it("never sets a decision automatically: no tep_in_place, no dnacpr_decision in the patch", () => {
    const plan = computeReferralPrefill(ref(), blank);
    expect(plan.patch).not.toHaveProperty("tep_in_place");
    expect(plan.patch).not.toHaveProperty("dnacpr_decision");
  });

  it("an explicit referral DNACPR is only OFFERED, and only for an unset (null) target", () => {
    expect(computeReferralPrefill(ref(), blank).decisions).toEqual([
      expect.objectContaining({ field: "dnacpr_decision", value: true }),
    ]);
    expect(computeReferralPrefill(ref({ resus_status: "for_cpr" }), blank).decisions).toEqual([
      expect.objectContaining({ field: "dnacpr_decision", value: false }),
    ]);
  });

  it("an explicit local false is preserved: nothing offered, nothing filled over it", () => {
    const plan = computeReferralPrefill(ref(), {
      ...blank,
      dnacpr_decision: false,
      tep_in_place: false,
    });
    expect(plan.decisions).toEqual([]);
    expect(plan.patch).not.toHaveProperty("dnacpr_decision");
    expect(plan.patch).not.toHaveProperty("tep_in_place");
  });

  it("ReSPECT alone does not imply DNACPR", () => {
    const plan = computeReferralPrefill(
      ref({ resus_status: "not_documented", dnacpr_respect: true }),
      blank,
    );
    expect(plan.decisions).toEqual([]);
    expect(plan.patch).not.toHaveProperty("dnacpr_details");
  });

  it("generic status or interventions don't imply a completed TEP", () => {
    const plan = computeReferralPrefill(
      ref({
        ceiling_of_care: "not_documented",
        resus_status: "not_documented",
        dnacpr_respect: false,
      }),
      blank,
    );
    expect(plan.patch).not.toHaveProperty("tep_in_place");
    expect(plan.decisions).toEqual([]);
  });

  it("never overwrites fields that already have content", () => {
    const plan = computeReferralPrefill(ref({ resus_status: "for_cpr" }), {
      ...blank,
      current_admission: "Existing note",
      tep_details: "Local TEP",
    });
    expect(plan.patch).not.toHaveProperty("current_admission");
    expect(plan.patch).not.toHaveProperty("tep_details");
    expect(plan.skipped_fields).toEqual(
      expect.arrayContaining(["current_admission", "tep_details"]),
    );
  });
});

describe("referral link and partner URL", () => {
  const R = "30000000-0000-4000-8000-000000000001";
  it("only an existing link to exactly this referral counts", () => {
    expect(prefillLinkState(R, R)).toBe("linked");
    expect(prefillLinkState(R.toUpperCase(), R)).toBe("linked");
    expect(prefillLinkState(null, R)).toBe("unlinked");
    expect(prefillLinkState("", R)).toBe("unlinked");
    expect(prefillLinkState("30000000-0000-4000-8000-000000000002", R)).toBe("mismatch");
  });
  it("the Critical Care Connect link carries the opaque referral id only", () => {
    expect(partnerReferralUrl("https://ccc.example/api/x?token=1", R)).toBe(
      `https://ccc.example/referrals/${R}`,
    );
    expect(partnerReferralUrl("http://ccc.example", R)).toBeNull();
    expect(partnerReferralUrl("https://ccc.example", "AB/../../x")).toBeNull();
    expect(partnerReferralUrl(undefined, R)).toBeNull();
  });
});
