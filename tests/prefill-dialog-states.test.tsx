// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Referral prefill dialog: errors, empty, retry and stale-preview handling. */
const h = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/lib/referral-prefill.functions", () => ({
  listReferralCandidates: (...a: unknown[]) => h.list(...a),
  previewReferralPrefill: (...a: unknown[]) => h.preview(...a),
  prefillPatientFromReferral: (...a: unknown[]) => h.apply(...a),
}));

import { PrefillFromReferral } from "@/components/patient/prefill-from-referral";
import { PREFILL_STALE_MESSAGE } from "@/lib/referral-prefill";

const PID = "00000000-0000-4000-8000-000000000001";
const RID = "00000000-0000-4000-8000-000000000002";
const candidate = {
  id: RID,
  age: 60,
  sex: "female",
  current_ward: "SYN ward",
  current_bed: "B1",
  referring_specialty: "medicine",
  referral_received_at: "2026-11-16T09:00:00Z",
  status: "pending",
  reason_category: "sepsis",
};
const previewAt = (v: string) => ({
  applied_fields: ["current_admission"],
  skipped_fields: [],
  patch: { current_admission: "Sepsis" },
  patient_updated_at: v,
  referral_updated_at: "r1",
});

const onDone = vi.fn();
function open() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <PrefillFromReferral patientId={PID} linked={false} onDone={onDone} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /from referral/i }));
}

beforeEach(() => {
  h.list.mockReset();
  h.preview.mockReset();
  h.apply.mockReset();
  onDone.mockReset();
});
afterEach(cleanup);

describe("prefill dialog states", () => {
  it("candidate load failure is an accessible alert with a working retry", async () => {
    h.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([candidate]);
    open();
    // The dialog retries once automatically before reporting failure.
    const alert = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(alert.textContent).toContain("Referrals couldn't be loaded");
    expect(screen.getByRole("button", { name: "Preview changes" })).toHaveProperty(
      "disabled",
      true,
    );
    const retry = screen.getByRole("button", { name: /try again/i });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { pressed: false })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirmed empty list says so", async () => {
    h.list.mockResolvedValue([]);
    open();
    expect(await screen.findByText("No synced referrals available.")).toBeTruthy();
  });

  it("preview failure blocks confirm and offers retry", async () => {
    h.list.mockResolvedValue([candidate]);
    h.preview.mockRejectedValue(new Error("offline"));
    open();
    fireEvent.click(await screen.findByRole("button", { pressed: false }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toContain(
      "preview couldn't be loaded",
    );
    expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("stale preview on concurrent edit: rejected, reload, reconfirm with the new version", async () => {
    h.list.mockResolvedValue([candidate]);
    h.preview.mockResolvedValueOnce(previewAt("v1")).mockResolvedValueOnce(previewAt("v2"));
    h.apply
      .mockRejectedValueOnce(new Error(PREFILL_STALE_MESSAGE))
      .mockResolvedValueOnce({ applied_fields: ["current_admission"], skipped_fields: [] });
    open();
    const pick = await screen.findByRole("button", { pressed: false });
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const confirm = await screen.findByRole("button", { name: "Confirm prefill" });
    await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PREFILL_STALE_MESSAGE);
    expect(h.apply.mock.calls[0][0].data).toMatchObject({
      expected_patient_updated_at: "v1",
      expected_referral_updated_at: "r1",
    });
    expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(onDone).toHaveBeenCalledTimes(1); // refreshes the record behind the dialog

    fireEvent.click(screen.getByRole("button", { name: /reload preview/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm prefill" }));
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(2));
    expect(h.apply.mock.calls[1][0].data.expected_patient_updated_at).toBe("v2");
  });
});
