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
function open(linkedReferralId: string | null, patientId = PID) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (pid: string, rid: string | null) => (
    <QueryClientProvider client={qc}>
      <PrefillFromReferral patientId={pid} linkedReferralId={rid} onDone={onDone} />
    </QueryClientProvider>
  );
  const r = render(ui(patientId, linkedReferralId));
  fireEvent.click(screen.getByRole("button", { name: /referral/i }));
  return { qc, rerender: (pid: string, rid: string | null) => r.rerender(ui(pid, rid)) };
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

// ---------------------------------------------------------------------------
// Confirmation is bound to the exact preview on screen.
// ---------------------------------------------------------------------------
const PID2 = "00000000-0000-4000-8000-000000000011";
const RID2 = "00000000-0000-4000-8000-000000000012";
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const withDecision = (pv: string, rv: string, value = true) =>
  previewAt(pv, {
    referral_updated_at: rv,
    decisions: [{ field: "dnacpr_decision", value, label: "The referral records DNACPR." }],
  });
const confirmBtn = () => screen.getByRole("button", { name: /confirm prefill|prefilling/i });
const dialogTitle = () => screen.queryByText("Review fields to be populated");

describe("confirmation bound to patient, referral and both revisions", () => {
  it("background refetch with a changed source decision clears the tick; controls locked while fetching", async () => {
    const second = deferred<unknown>();
    h.preview
      .mockResolvedValueOnce(withDecision("v1", "r1", true))
      .mockReturnValueOnce(second.promise);
    h.apply.mockResolvedValue({ applied_fields: [], skipped_fields: [] });
    const { qc } = open(RID);
    const box = await screen.findByRole("checkbox");
    fireEvent.click(box);
    expect(box).toHaveProperty("checked", true);
    // Simulates the window-focus / background refetch.
    void qc.refetchQueries({ queryKey: ["referral-prefill-preview"] });
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true));
    expect(confirmBtn()).toHaveProperty("disabled", true);
    second.resolve(withDecision("v1", "r2", false));
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("disabled", false));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    expect(screen.getByText(/Also record .*: No/)).toBeTruthy();
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0][0].data).toMatchObject({
      expected_referral_updated_at: "r2",
      accept_decisions: [],
    });
  });

  it("a refetch returning the same revision keeps the tick (same visible preview)", async () => {
    h.preview.mockResolvedValue(withDecision("v1", "r1"));
    h.apply.mockResolvedValue({ applied_fields: ["dnacpr_decision"], skipped_fields: [] });
    const { qc } = open(RID);
    fireEvent.click(await screen.findByRole("checkbox"));
    await qc.refetchQueries({ queryKey: ["referral-prefill-preview"] });
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("disabled", false));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(h.apply).toHaveBeenCalled());
    expect(h.apply.mock.calls[0][0].data.accept_decisions).toEqual(["dnacpr_decision"]);
  });

  it("close and reopen never inherits a tick, and a late earlier preview is ignored", async () => {
    const first = deferred<unknown>();
    h.preview
      .mockResolvedValueOnce(withDecision("v1", "r1"))
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(withDecision("v3", "r3"));
    h.apply.mockResolvedValue({ applied_fields: [], skipped_fields: [] });
    open(RID);
    fireEvent.click(await screen.findByRole("checkbox"));
    // Close; reopen (request #2 hangs); close; reopen (request #3 answers).
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /referral/i }));
    await waitFor(() => expect(h.preview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /referral/i }));
    await waitFor(() => expect(h.preview).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(confirmBtn()).toHaveProperty("disabled", false));
    first.resolve(withDecision("v2", "r2")); // out of order, from a closed session
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0][0].data).toMatchObject({
      expected_patient_updated_at: "v3",
      expected_referral_updated_at: "r3",
      accept_decisions: [],
    });
  });

  it("a write that finishes after close/reopen does not dismiss the new dialog or show its result", async () => {
    const write = deferred<unknown>();
    h.preview.mockResolvedValue(withDecision("v1", "r1"));
    h.apply.mockReturnValueOnce(write.promise);
    open(RID);
    await waitFor(() => expect(confirmBtn()).toHaveProperty("disabled", false));
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /referral/i }));
    expect(dialogTitle()).toBeTruthy();
    write.resolve({ applied_fields: ["current_admission"], skipped_fields: [] });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1)); // data refresh only
    expect(dialogTitle()).toBeTruthy();
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  });

  it("a stale rejection from an earlier session does not mark the new dialog stale", async () => {
    const write = deferred<unknown>();
    h.preview.mockResolvedValue(previewAt("v1"));
    h.apply.mockReturnValueOnce(write.promise);
    open(RID);
    await waitFor(() => expect(confirmBtn()).toHaveProperty("disabled", false));
    fireEvent.click(confirmBtn());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /referral/i }));
    write.reject(new Error(PREFILL_STALE_MESSAGE));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(PREFILL_STALE_MESSAGE)).toBeNull();
    await waitFor(() => expect(confirmBtn()).toHaveProperty("disabled", false));
  });

  it("switching patient while a write is pending closes the dialog and never completes the new target", async () => {
    const write = deferred<unknown>();
    h.preview.mockResolvedValue(withDecision("v1", "r1"));
    h.apply.mockReturnValueOnce(write.promise);
    const { rerender } = open(RID);
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(confirmBtn()).toHaveProperty("disabled", false));
    fireEvent.click(confirmBtn());
    rerender(PID2, RID2);
    await waitFor(() => expect(dialogTitle()).toBeNull());
    write.resolve({ applied_fields: ["dnacpr_decision"], skipped_fields: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(onDone).not.toHaveBeenCalled();
    // The new patient's dialog starts clean and previews the new target.
    fireEvent.click(screen.getByRole("button", { name: /referral/i }));
    await waitFor(() =>
      expect(h.preview.mock.calls.at(-1)![0].data).toEqual({
        patient_id: PID2,
        referral_id: RID2,
      }),
    );
    expect(await screen.findByRole("checkbox")).toHaveProperty("checked", false);
  });

  it("a different referral for the same patient does not inherit the tick", async () => {
    h.preview.mockResolvedValue(withDecision("v1", "r1"));
    const { rerender } = open(RID);
    fireEvent.click(await screen.findByRole("checkbox"));
    rerender(PID, RID2);
    fireEvent.click(screen.getByRole("button", { name: /referral/i }));
    const box = await screen.findByRole("checkbox");
    expect(box).toHaveProperty("checked", false);
    expect(h.preview.mock.calls.at(-1)![0].data.referral_id).toBe(RID2);
  });
});
