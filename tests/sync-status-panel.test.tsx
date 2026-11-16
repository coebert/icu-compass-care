// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Header sync indicator, stubbed server calls. No manual sync is run. */
const h = vi.hoisted(() => ({ status: vi.fn(), run: vi.fn() }));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/lib/sync.functions", () => ({
  getSyncStatus: () => h.status(),
  runBridgeSyncFn: () => h.run(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "synthetic" } } }) },
  },
}));

import { SyncStatusPanel } from "@/components/SyncStatusPanel";

const recent = () => new Date(Date.now() - 2 * 60_000).toISOString();
const res = (entity: string, over: Record<string, unknown> = {}) => ({
  entity,
  unavailable: false,
  lastAttemptAt: recent(),
  lastAttemptOk: true,
  lastAttemptCode: null,
  lastSuccessAt: recent(),
  lastSuccessCount: 0,
  ...over,
});
const granted = (resources: unknown[], canRetry = false) => ({
  access: "granted",
  checkedAt: new Date().toISOString(),
  delayedAfterMinutes: 30,
  resources,
  canRetry,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SyncStatusPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.status.mockReset();
  h.run.mockReset();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("sync status panel", () => {
  it("a failed status query is shown as unavailable, with a check-again control", async () => {
    h.status.mockRejectedValue(new Error("offline"));
    mount();
    const trigger = await screen.findByRole("button", { name: /sync status unavailable/i });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect((await screen.findByRole("alert")).textContent).toContain("couldn't be loaded");
    expect(screen.getByRole("button", { name: /check again/i })).toBeTruthy();
  });

  it("one failing stream is not hidden by three healthy ones; raw text never shown", async () => {
    h.status.mockResolvedValue(
      granted([
        res("patients"),
        res("investigations"),
        res("referrals", { lastAttemptOk: false, lastAttemptCode: "partner_http_error" }),
        res("microbiology"),
      ]),
    );
    mount();
    const trigger = await screen.findByRole("button", { name: /last update failed/i });
    fireEvent.click(trigger);
    const list = await screen.findByRole("list", { name: /by record type/i });
    expect(list.textContent).toContain("Referrals");
    expect(list.textContent).toContain("The partner system returned an error.");
    expect(list.textContent).not.toMatch(/next scheduled/i);
    // Auditor view: no retry offered.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("partial write failure reads as incomplete", async () => {
    h.status.mockResolvedValue(
      granted([
        res("patients", { lastAttemptOk: false, lastAttemptCode: "partial_write_failure" }),
        res("investigations"),
        res("referrals"),
        res("microbiology"),
      ]),
    );
    mount();
    expect(await screen.findByRole("button", { name: /sync incomplete/i })).toBeTruthy();
  });

  it("valid empty pulls on every stream read as synced, no invented next run", async () => {
    h.status.mockResolvedValue(
      granted(["patients", "investigations", "referrals", "microbiology"].map((e) => res(e))),
    );
    mount();
    const trigger = await screen.findByRole("button", { name: /synced 2 min ago/i });
    fireEvent.click(trigger);
    expect(document.body.textContent).not.toMatch(/next scheduled|every \d+ min/i);
  });

  it("restricted staff see nothing", async () => {
    h.status.mockResolvedValue({ access: "restricted" });
    const { container } = mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("Trust admin retry is offered on failure but not triggered by rendering", async () => {
    h.status.mockResolvedValue(
      granted(
        [
          res("patients", { unavailable: true }),
          res("investigations"),
          res("referrals"),
          res("microbiology"),
        ],
        true,
      ),
    );
    mount();
    expect(await screen.findByRole("button", { name: "Retry partner sync" })).toBeTruthy();
    expect(h.run).not.toHaveBeenCalled();
  });
});
