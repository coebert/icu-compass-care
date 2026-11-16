// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

const h = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/lib/patients.functions", () => ({
  findPreviousAdmissions: (...a: unknown[]) => h.find(...a),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...p }: { children: React.ReactNode }) => (
    <a href="#prev" {...(p as object)}>
      {children}
    </a>
  ),
}));

import { PreviousAdmissionBanner } from "@/components/PreviousAdmissionBanner";
import { applyHistoricalPatch, type PreviousAdmission } from "@/lib/previous-admission";
import type { PatientFormValues } from "@/components/PatientForm";

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

type Form = Pick<
  PatientFormValues,
  "hospital_number" | "full_name" | "age" | "past_medical_history" | "tep_in_place" | "dnacpr_decision"
>;
let latest: Form;
let setFormRef: (f: Form) => void;
function Harness({ initial }: { initial: Form }) {
  const [form, setForm] = useState(initial);
  latest = form;
  setFormRef = setForm;
  return (
    <PreviousAdmissionBanner
      values={form as unknown as PatientFormValues}
      onApply={(patch, verifiedFor) =>
        setForm((f) =>
          patch.past_medical_history
            ? applyHistoricalPatch(f, { past_medical_history: patch.past_medical_history }, verifiedFor)
            : f,
        )
      }
    />
  );
}
const base: Form = {
  hospital_number: "SYN1234",
  full_name: "S.Y.",
  age: "70",
  past_medical_history: "",
  tep_in_place: false,
  dnacpr_decision: false,
};
function mount(initial: Partial<Form> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness initial={{ ...base, ...initial }} />
    </QueryClientProvider>,
  );
}
const copyBtn = () => screen.getByRole("button", { name: "Copy past medical history" });

beforeEach(() => h.find.mockReset());
afterEach(cleanup);

describe("PreviousAdmissionBanner", () => {
  it("no hospital number: never looks up by initials + age, shows nothing", async () => {
    h.find.mockResolvedValue([rec()]);
    mount({ hospital_number: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.find).not.toHaveBeenCalled();
    expect(screen.queryByText(/previous critical care admission/i)).toBeNull();
  });
  it("same initials + age but a different hospital number is not shown", async () => {
    h.find.mockResolvedValue([rec({ hospital_number: "SYN9999" })]);
    mount();
    await waitFor(() => expect(h.find).toHaveBeenCalled());
    expect(h.find.mock.calls[0][0].data).toEqual({ hospital_number: "SYN1234" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/previous critical care admission/i)).toBeNull();
  });
  it("exact match: copies labelled PMH only; TEP/DNACPR shown, never imported; false kept", async () => {
    h.find.mockResolvedValue([rec()]);
    mount({ hospital_number: "syn-1234" });
    expect(await screen.findByText(/with this hospital number/)).toBeTruthy();
    expect(screen.getByText(/TEP then:/).closest("p")!.textContent).toContain("Yes — Synthetic TEP");
    expect(screen.getByText(/Not copied/)).toBeTruthy();
    fireEvent.click(copyBtn());
    expect(latest.past_medical_history).toBe(
      "From previous critical care admission (02/01/2026 – 09/01/2026) — needs review:\nSynthetic COPD",
    );
    expect(latest.tep_in_place).toBe(false);
    expect(latest.dnacpr_decision).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("marked for review");
  });
  it("existing PMH is preserved and copy is unavailable", async () => {
    h.find.mockResolvedValue([rec()]);
    mount({ past_medical_history: "Current text" });
    await screen.findByText(/with this hospital number/);
    expect(copyBtn()).toHaveProperty("disabled", true);
    expect(screen.getByText(/already entered — kept/)).toBeTruthy();
    expect(latest.past_medical_history).toBe("Current text");
  });
  it("several admissions: nothing can be copied until one is explicitly chosen", async () => {
    h.find.mockResolvedValue([
      rec({ id: "p-new", past_medical_history: "Newer PMH", admission_date: "2026-03-01" }),
      rec({ id: "p-old", past_medical_history: "Older PMH" }),
    ]);
    mount();
    expect(await screen.findByText(/2 previous critical care admissions/)).toBeTruthy();
    expect(copyBtn()).toHaveProperty("disabled", true);
    expect(screen.queryByText(/TEP then:/)).toBeNull();
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    fireEvent.click(copyBtn());
    expect(latest.past_medical_history).toContain("Older PMH");
    expect(latest.past_medical_history).not.toContain("Newer PMH");
  });
  it("a late result for an earlier hospital number never populates the new patient", async () => {
    let resolveOld!: (v: unknown) => void;
    h.find.mockImplementation((...args: unknown[]) =>
      (console.log("ARGS", JSON.stringify(args)), (args[0] as { data: { hospital_number: string } }).data.hospital_number === "SYN1234")
        ? new Promise((r) => (resolveOld = r))
        : Promise.resolve([]),
    );
    mount();
    await waitFor(() => expect(h.find).toHaveBeenCalledTimes(1));
    act(() => setFormRef({ ...latest, hospital_number: "SYN5678" }));
    await waitFor(() => expect(h.find).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld([rec()]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/with this hospital number/)).toBeNull();
    expect(latest.past_medical_history).toBe("");
  });
  it("number changed after the banner showed: a click on the old banner state cannot patch the new form", () => {
    // The parent-side guard re-checks the latest form.
    const f = { ...base, hospital_number: "SYN5678" };
    expect(applyHistoricalPatch(f, { past_medical_history: "X" }, "SYN1234")).toBe(f);
  });
});
