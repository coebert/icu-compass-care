import { describe, it, expect, vi } from "vitest";

/**
 * Previous-admission identity and copy rules, with synthetic records only.
 * The database is an in-memory spy; crypto helpers are identity stand-ins.
 */
vi.mock("@/lib/patient-crypto.server", () => ({
  withCryptoColumns: (s: string) => s,
  patientLookupHash: (v: string | null | undefined) => (v ? `h:${v}` : null),
  decryptPatientRows: (r: unknown[] | null) => r ?? [],
}));

import {
  applyHistoricalPatch,
  historicalPmhPatch,
  normaliseHospitalNumber,
  verifiedPreviousAdmissions,
  type PreviousAdmission,
} from "@/lib/previous-admission";
import { findVerifiedPreviousAdmissions } from "@/lib/previous-admission.server";

const rec = (over: Partial<PreviousAdmission> = {}): PreviousAdmission => ({
  id: "p-old-1",
  full_name: "S.Y.",
  hospital_number: "SYN1234",
  age: 70,
  status: "discharged",
  admission_date: "2026-01-02",
  discharge_date: "2026-01-09",
  date_of_death: null,
  past_medical_history: "Synthetic COPD",
  tep_in_place: true,
  tep_details: "Synthetic TEP",
  dnacpr_decision: true,
  dnacpr_details: "Synthetic DNACPR",
  dnacpr_date: "2026-01-03",
  ...over,
});

function fakeSupabase(rows: unknown[]) {
  const calls: unknown[][] = [];
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "neq"])
    b[m] = (...a: unknown[]) => (calls.push([m, ...a]), b);
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
  const from = vi.fn(() => b);
  return { client: { from } as never, calls, from };
}

describe("identity: exact normalised hospital number only", () => {
  it("normalises like the lookup hash (trim, case, separators)", () => {
    expect(normaliseHospitalNumber("  syn-12 34 ")).toBe("SYN1234");
    expect(normaliseHospitalNumber("")).toBe("");
    expect(normaliseHospitalNumber(null)).toBe("");
  });
  it("same initials + age but a different hospital number is not a match", () => {
    expect(verifiedPreviousAdmissions("SYN9999", [rec()])).toEqual([]);
  });
  it("missing hospital number matches nothing, even with identical initials + age", () => {
    expect(verifiedPreviousAdmissions("", [rec()])).toEqual([]);
    expect(verifiedPreviousAdmissions("   ", [rec()])).toEqual([]);
  });
  it("a record with no readable hospital number is never a match", () => {
    expect(verifiedPreviousAdmissions("SYN1234", [rec({ hospital_number: null })])).toEqual([]);
  });
  it("exact normalised match is accepted", () => {
    expect(verifiedPreviousAdmissions("syn 1234", [rec()])).toHaveLength(1);
  });
});

describe("server lookup", () => {
  it("no hospital number: no query at all (initials + age are never used)", async () => {
    const s = fakeSupabase([rec()]);
    expect(await findVerifiedPreviousAdmissions(s.client, { hospital_number: "" })).toEqual([]);
    expect(s.from).not.toHaveBeenCalled();
  });
  it("queries by the hash of the normalised number and re-verifies the decrypted value", async () => {
    // A hash hit whose decrypted number differs (collision / stale data) is dropped.
    const s = fakeSupabase([rec(), rec({ id: "p-other", hospital_number: "SYN9999" })]);
    const out = await findVerifiedPreviousAdmissions(s.client, { hospital_number: " syn-1234" });
    expect(out.map((r) => r.id)).toEqual(["p-old-1"]);
    expect(s.calls).toContainEqual(["eq", "hospital_number_hash", "h:SYN1234"]);
    expect(s.calls.some((c) => c[1] === "full_name_hash" || c[1] === "age")).toBe(false);
  });
  it("no longer selects TEP exclusions (never copied)", async () => {
    const s = fakeSupabase([]);
    await findVerifiedPreviousAdmissions(s.client, { hospital_number: "SYN1234" });
    const select = s.calls.find((c) => c[0] === "select")![1] as string;
    expect(select).not.toContain("tep_exclusions");
  });
});

describe("copy: past medical history only, into a blank field, labelled", () => {
  it("copies labelled PMH with the source admission dates", () => {
    const p = historicalPmhPatch({ past_medical_history: "" }, rec());
    expect(p).toEqual({
      past_medical_history:
        "From previous critical care admission (02/01/2026 – 09/01/2026) — needs review:\nSynthetic COPD",
    });
  });
  it("existing PMH is preserved", () => {
    expect(historicalPmhPatch({ past_medical_history: "Current text" }, rec())).toBeNull();
  });
  it("historical TEP / DNACPR booleans, details and dates are never in the patch", () => {
    const p = historicalPmhPatch({ past_medical_history: "" }, rec())!;
    expect(Object.keys(p)).toEqual(["past_medical_history"]);
  });
  it("applyHistoricalPatch keeps explicit false values and every other current field", () => {
    const form = {
      hospital_number: "SYN1234",
      past_medical_history: "",
      tep_in_place: false,
      dnacpr_decision: false,
      dnacpr_date: "",
    };
    const out = applyHistoricalPatch(form, { past_medical_history: "X" }, "SYN1234");
    expect(out).toEqual({ ...form, past_medical_history: "X" });
    expect(out.tep_in_place).toBe(false);
    expect(out.dnacpr_decision).toBe(false);
  });
  it("a late patch for an earlier hospital number never populates the current form", () => {
    const form = { hospital_number: "SYN5678", past_medical_history: "" };
    expect(applyHistoricalPatch(form, { past_medical_history: "X" }, "SYN1234")).toBe(form);
  });
  it("text typed meanwhile wins over the patch", () => {
    const form = { hospital_number: "SYN1234", past_medical_history: "typed" };
    expect(applyHistoricalPatch(form, { past_medical_history: "X" }, "SYN1234")).toBe(form);
  });
});
