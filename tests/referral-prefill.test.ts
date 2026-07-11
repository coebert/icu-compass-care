import { describe, it, expect } from "vitest";
import { computeReferralPrefill, type PatientPrefillTarget } from "@/lib/referral-prefill";

const blank: PatientPrefillTarget = {
  current_admission: null,
  current_management: null,
  tep_in_place: null,
  tep_details: null,
  dnacpr_decision: null,
  dnacpr_details: null,
};

describe("computeReferralPrefill", () => {
  it("maps a DNACPR / ceiling referral onto a blank patient", () => {
    const plan = computeReferralPrefill(
      {
        reason_category: "sepsis",
        ceiling_of_care: "no_cpr",
        resus_status: "dnacpr",
        dnacpr_respect: true,
        anticipated_interventions: ["vasopressors", "rrt"],
        allergies: "Penicillin",
        weight_kg: 80,
        admission_urgency: "urgent",
      },
      blank,
    );
    expect(plan.patch.dnacpr_decision).toBe(true);
    expect(plan.patch.tep_in_place).toBe(true);
    expect(plan.patch.current_admission).toBe("Sepsis");
    expect(String(plan.patch.current_management)).toContain("Vasopressors");
    expect(String(plan.patch.current_management)).toContain("Penicillin");
    expect(plan.applied_fields).toContain("dnacpr_details");
  });

  it("never overwrites fields that already have content", () => {
    const plan = computeReferralPrefill(
      {
        reason_category: "sepsis",
        ceiling_of_care: "full_escalation",
        resus_status: "for_cpr",
        dnacpr_respect: false,
        anticipated_interventions: null,
        allergies: null,
        weight_kg: null,
        admission_urgency: null,
      },
      { ...blank, current_admission: "Existing note", tep_in_place: true },
    );
    expect(plan.patch.current_admission).toBeUndefined();
    expect(plan.skipped_fields).toContain("current_admission");
    expect(plan.patch.tep_in_place).toBeUndefined();
    expect(plan.skipped_fields).toContain("tep_in_place");
  });

  it("produces no DNACPR decision when resus is for CPR", () => {
    const plan = computeReferralPrefill(
      {
        reason_category: null,
        ceiling_of_care: null,
        resus_status: "for_cpr",
        dnacpr_respect: false,
        anticipated_interventions: null,
        allergies: null,
        weight_kg: null,
        admission_urgency: null,
      },
      blank,
    );
    expect(plan.patch.dnacpr_decision).toBeUndefined();
  });
});
