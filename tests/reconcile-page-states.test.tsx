// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Cross-project sync review page: denied vs failed vs offline loads, stale
 * data after a failed refresh, per-entity errors with retry, truthful
 * ownership wording and keyboard-operable pulls. Synthetic data only.
 */
const h = vi.hoisted(() => ({ get: vi.fn(), pull: vi.fn() }));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
}));
vi.mock("@/lib/reconcile.functions", () => ({
  getReconciliation: (...a: unknown[]) => h.get(...a),
  reconcilePartner: (...a: unknown[]) => h.pull(...a),
}));
vi.mock("@/components/BridgeHealthCheck", () => ({ BridgeHealthCheck: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { Route } from "@/routes/_authenticated/reconcile";
import type { EntityRecon, ReconRow } from "@/lib/reconcile.functions";
import { RECON_REASON_TEXT } from "@/lib/reconcile-text";

const Page = (Route as unknown as { component: () => JSX.Element }).component;
const RID = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;
const row = (n: number, over: Partial<ReconRow>): ReconRow => ({
  id: RID(n),
  label: "Medicine",
  sub: "pending",
  localVersion: "2026-11-16T09:00:00Z",
  remoteVersion: "2026-11-16T10:00:00Z",
  state: "diverged",
  reason: "partner_newer",
  pullable: true,
  ...over,
});
const ent = (entity: EntityRecon["entity"], over: Partial<EntityRecon> = {}): EntityRecon => ({
  entity,
  localCount: 1,
  remoteCount: 1,
  matched: 1,
  mismatches: [],
  importable: entity === "referrals",
  partnerListComplete: true,
  ...over,
});
const result = (refs: Partial<EntityRecon>) => [
  ent("notifications"),
  ent("referrals", refs),
  ent("audit_log"),
];

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Page />
    </QueryClientProvider>,
  );
}
async function openReferrals() {
  const tab = await screen.findByRole("tab", { name: /Referrals/ });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.focus(tab);
  await waitFor(() => expect(tab.getAttribute("data-state")).toBe("active"));
}

beforeEach(() => {
  h.get.mockReset();
  h.pull.mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
afterEach(cleanup);

describe("reconcile page", () => {
  it("a permission refusal says so and offers no retry", async () => {
    h.get.mockRejectedValue(new Error("Forbidden: Trust administrators only"));
    mount();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Only Trust administrators can review cross-project sync.",
    );
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("a network/backend failure is not shown as a permission problem and can be retried", async () => {
    h.get.mockRejectedValueOnce(new Error("Failed to fetch"));
    h.get.mockResolvedValueOnce(result({}));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load right now/);
    expect(alert.textContent).not.toMatch(/permission|Trust administrators/);
    fireEvent.click(within(alert).getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: "Cross-project sync review" })).toBeTruthy();
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it("offline is named as offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    h.get.mockRejectedValue(new Error("Failed to fetch"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toMatch(/offline/);
  });

  it("a failed refresh keeps the last result, marks it out of date and disables pulls", async () => {
    h.get.mockResolvedValueOnce(result({ mismatches: [row(1, {})] }));
    mount();
    await openReferrals();
    const pullBtn = await screen.findAllByRole("button", { name: /Pull Medicine from Critical Care Connect/ });
    expect(pullBtn[0]!.hasAttribute("disabled")).toBe(false);
    h.get.mockRejectedValueOnce(new Error("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toMatch(/may be out of date/);
    for (const b of screen.getAllByRole("button", { name: /Pull Medicine/ }))
      expect(b.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Pull all/ })).toBeNull();
  });

  it("an error on one list is shown on that list with a retry; the others still load", async () => {
    h.get.mockResolvedValue(
      result({ error: "Referrals can't be compared yet.", localCount: 0, remoteCount: 0, matched: 0 }),
    );
    mount();
    expect(await screen.findByText(/Everything is in sync/)).toBeTruthy(); // notifications
    await openReferrals();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/can't be compared yet/);
    expect(screen.queryByText(/in sync/)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
  });

  it("a referral only here never says the partner must pull", async () => {
    h.get.mockResolvedValue(
      result({ mismatches: [row(2, { state: "local_only", reason: "local_record", pullable: false, remoteVersion: null })] }),
    );
    mount();
    await openReferrals();
    expect((await screen.findAllByText(RECON_REASON_TEXT.local_record)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/partner must pull/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Pull/ })).toBeNull();
  });

  it("ownership conflicts get no pull buttons and no promise that pulling fixes them", async () => {
    h.get.mockResolvedValue(
      result({
        matched: 0,
        mismatches: [row(3, { state: "conflict", reason: "not_imported", pullable: false })],
      }),
    );
    mount();
    await openReferrals();
    expect((await screen.findAllByText("Needs review")).length).toBeGreaterThan(0);
    expect(screen.getByText(/need[s]? a person to review\. Pulling won't change it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pull/ })).toBeNull();
    expect(screen.queryByText(/Everything is in sync/)).toBeNull();
  });

  it("an unconfirmed partner list doesn't claim everything is in sync", async () => {
    h.get.mockResolvedValue([
      ent("notifications", { partnerListComplete: false }),
      ent("referrals"),
      ent("audit_log"),
    ]);
    mount();
    expect(await screen.findByText(/didn't confirm its list is complete/)).toBeTruthy();
    expect(screen.queryByText(/Everything is in sync with Critical Care Connect/)).toBeNull();
  });

  it("pulls one record from the keyboard with only that id", async () => {
    h.get.mockResolvedValue(
      result({
        mismatches: [
          row(5, { state: "conflict", reason: "local_edit", pullable: false, label: "Surgery" }),
          row(4, {}),
          row(6, { state: "local_only", reason: "local_record", pullable: false, remoteVersion: null }),
        ],
      }),
    );
    h.pull.mockResolvedValue({ applied: 1, failed: 0, skipped: 0, conflicts: 0, errors: [] });
    const { container } = mount();
    await openReferrals();
    const [btn] = await screen.findAllByRole("button", { name: /Pull Medicine from Critical Care Connect/ });
    btn!.focus();
    expect(document.activeElement).toBe(btn);
    // Native <button>: Enter/Space activate it as a click.
    fireEvent.click(btn!);
    await waitFor(() =>
      expect(h.pull).toHaveBeenCalledWith({ data: { entity: "referrals", ids: [RID(4)] } }),
    );
    // Static snapshot for the phone/desktop visual check (synthetic data).
    if (process.env.RECON_SNAPSHOT_DIR) {
      mkdirSync(process.env.RECON_SNAPSHOT_DIR, { recursive: true });
      writeFileSync(`${process.env.RECON_SNAPSHOT_DIR}/reconcile.html`, container.innerHTML);
    }
  });
});
