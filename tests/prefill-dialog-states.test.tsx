// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Referral prefill dialog: linked-only copying, the Critical Care Connect
 * link for unlinked patients, errors/empty/retry and stale-preview handling.
 */
const h = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  base: vi.fn(),
}));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/lib/referral-prefill.functions", () => ({
  listReferralCandidates: (...a: unknown[]) => h.list(...a),
  previewReferralPrefill: (...a: unknown[]) => h.preview(...a),
  prefillPatientFromReferral: (...a: unknown[]) => h.apply(...a),
  getPartnerReferralBase: (...a: unknown[]) => h.base(...a),
}));

import { PrefillFromReferral } from "@/components/patient/prefill-from-referral";
import { PREFILL_STALE_MESSAGE, REFERRAL_LINK_REQUIRED_MESSAGE } from "@/lib/referral-prefill";

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
const previewAt = (v: string, extra: Record<string, unknown> = {}) => ({
  link: "linked",
  applied_fields: ["current_admission"],
  skipped_fields: [],
  patch: {
    current_admission: "From critical care referral — needs review: referral reason: Sepsis.",
  },
  decisions: [],
  patient_updated_at: v,
  referral_updated_at: "r1",
  ...extra,
});

const onDone = vi.fn();
function open(linkedReferralId: string | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <PrefillFromReferral patientId={PID} linkedReferralId={linkedReferralId} onDone={onDone} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /referral/i }));
}

beforeEach(() => {
  h.list.mockReset();
  h.preview.mockReset();
  h.apply.mockReset();
  h.base.mockReset();
  h.base.mockResolvedValue({ origin: "https://ccc.example" });
  onDone.mockReset();
});
afterEach(cleanup);

describe("unlinked patient", () => {
  it("never previews or copies; each referral opens in Critical Care Connect by opaque id only", async () => {
    h.list.mockResolvedValue([candidate]);
    open(null);
    const list = await screen.findByRole("list", { name: "Referrals" });
    const link = await within(list).findByRole("link", { name: /open in critical care connect/i });
    expect(link.getAttribute("href")).toBe(`https://ccc.example/referrals/${RID}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("button", { name: /confirm prefill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("candidate load failure is an accessible alert with a working retry", async () => {
    h.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([candidate]);
    open(null);
    const alert = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(alert.textContent).toContain("Referrals couldn't be loaded");
    const retry = screen.getByRole("button", { name: /try again/i });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(
      await screen.findByRole("link", { name: /open in critical care connect/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("confirmed empty list says so", async () => {
    h.list.mockResolvedValue([]);
    open(null);
    expect(await screen.findByText("No synced referrals available.")).toBeTruthy();
  });
});

describe("linked patient", () => {
  it("previews the linked referral directly; confirm uses the previewed versions", async () => {
    h.preview.mockResolvedValue(previewAt("v1"));
    h.apply.mockResolvedValue({ applied_fields: ["current_admission"], skipped_fields: [] });
    open(RID);
    const confirm = await screen.findByRole("button", { name: "Confirm prefill" });
    await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
    expect(h.preview.mock.calls[0][0].data).toEqual({ patient_id: PID, referral_id: RID });
    expect(h.list).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0][0].data).toMatchObject({
      referral_id: RID,
      expected_patient_updated_at: "v1",
      expected_referral_updated_at: "r1",
      accept_decisions: [],
    });
  });
  it("a documented decision is applied only when ticked", async () => {
    h.preview.mockResolvedValue(
      previewAt("v1", {
        decisions: [
          { field: "dnacpr_decision", value: true, label: "The referral records DNACPR." },
        ],
      }),
    );
    h.apply.mockResolvedValue({ applied_fields: ["dnacpr_decision"], skipped_fields: [] });
    open(RID);
    const box = await screen.findByRole("checkbox");
    expect(box).toHaveProperty("checked", false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Confirm prefill" }));
    await waitFor(() => expect(h.apply).toHaveBeenCalled());
    expect(h.apply.mock.calls[0][0].data.accept_decisions).toEqual(["dnacpr_decision"]);
  });
  it("preview failure blocks confirm and offers retry", async () => {
    h.preview.mockRejectedValue(new Error("offline"));
    open(RID);
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toContain(
      "preview couldn't be loaded",
    );
    expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("a server-side link mismatch blocks copying and links to Critical Care Connect", async () => {
    h.preview.mockResolvedValue({
      link: "mismatch",
      partner_referral_url: `https://ccc.example/referrals/${RID}`,
    });
    open(RID);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("linked to a different referral");
    expect(within(alert).getByRole("link").getAttribute("href")).toBe(
      `https://ccc.example/referrals/${RID}`,
    );
    expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
      "disabled",
      true,
    );
  });
  it("link removed before saving: refused, explained, record refreshed", async () => {
    h.preview.mockResolvedValue(previewAt("v1"));
    h.apply.mockRejectedValue(new Error(REFERRAL_LINK_REQUIRED_MESSAGE));
    open(RID);
    const confirm = await screen.findByRole("button", { name: "Confirm prefill" });
    await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
    fireEvent.click(confirm);
    expect((await screen.findByRole("alert")).textContent).toContain("isn't linked");
    expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it("stale preview on concurrent edit: rejected, reload, reconfirm with the new version", async () => {
    h.preview.mockResolvedValueOnce(previewAt("v1")).mockResolvedValueOnce(previewAt("v2"));
    h.apply
      .mockRejectedValueOnce(new Error(PREFILL_STALE_MESSAGE))
      .mockResolvedValueOnce({ applied_fields: ["current_admission"], skipped_fields: [] });
    open(RID);
    const confirm = await screen.findByRole("button", { name: "Confirm prefill" });
    await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
    fireEvent.click(confirm);
    expect((await screen.findByRole("alert")).textContent).toContain(PREFILL_STALE_MESSAGE);
    expect(screen.getByRole("button", { name: "Confirm prefill" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
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
