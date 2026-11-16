// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Patient board load states with synthetic rows and stubbed server calls:
 * a failed or stale query must never render beds as empty/free, and a
 * filtered-out patient's bed must stay occupied.
 */
const h = vi.hoisted(() => ({
  search: { q: "", sex: "all", archived: false, density: "detailed", preset: "" },
  listPatients: (() => Promise.resolve([])) as () => Promise<unknown>,
  listBeds: (() => Promise.resolve([])) as () => Promise<unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => h.search,
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a href="#" {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/lib/patients.functions", () => ({
  listPatients: () => h.listPatients(),
  createPatient: vi.fn(),
  updatePatient: vi.fn(),
}));
vi.mock("@/lib/beds.functions", () => ({ listBeds: () => h.listBeds() }));
vi.mock("@/lib/observations.functions", () => ({ listLatestObservations: async () => [] }));
vi.mock("@/lib/investigations.functions", () => ({ listLatestKeyInvestigations: async () => [] }));
vi.mock("@/hooks/use-checklist-alerts", () => ({
  useChecklistAlerts: () => ({ missed: [], overdue: [] }),
}));
vi.mock("@/components/ChecklistAlertsPanel", () => ({ ChecklistAlertsPanel: () => null }));
vi.mock("@/components/HandoverPreviewModal", () => ({ HandoverPreviewModal: () => null }));
vi.mock("@/components/patient/chart-scanner", () => ({ ScanChartDialog: () => null }));
vi.mock("@/components/PreviousAdmissionBanner", () => ({ PreviousAdmissionBanner: () => null }));
vi.mock("@/components/PatientForm", () => ({ PatientForm: () => null, emptyPatient: () => ({}) }));
vi.mock("@/components/patient/move-to-bed-menu", () => ({ MoveToBedMenu: () => null }));
vi.mock("@/components/patient/observations-card", () => ({ AcuityBadge: () => null }));

import { Route } from "@/routes/_authenticated/patients.index";

const roster = [
  { id: "b1", label: "1", position: 1, is_side_room: true },
  { id: "b2", label: "2", position: 2, is_side_room: false },
  { id: "b3", label: "3", position: 3, is_side_room: false },
];
const pt = (id: string, bed: string, sex: string) => ({
  id,
  full_name: `Z${id.toUpperCase()}`,
  hospital_number: `SYN${id}`,
  sex,
  bed,
  status: "admitted",
  location_type: "icu",
  updated_at: "2026-11-16T10:00:00Z",
});

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Board = (Route as any).component as () => JSX.Element;
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <Board />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  h.search = { q: "", sex: "all", archived: false, density: "detailed", preset: "" };
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("patient board states", () => {
  it("initial load failure shows an error with retry and no beds at all", async () => {
    h.listPatients = () => Promise.reject(new Error("offline"));
    h.listBeds = () => Promise.resolve(roster);
    renderBoard();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The patient board couldn't be loaded");
    expect(screen.queryByText("Empty")).toBeNull();
    expect(screen.queryByText(/Tap to admit/)).toBeNull();
    // Retry is a real, focusable button (keyboard/touch operable).
    const retry = screen.getByRole("button", { name: /try again/i });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    h.listPatients = () => Promise.resolve([]);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByText("The patient board couldn't be loaded")).toBeNull(),
    );
  });

  it("confirmed empty: beds shown as empty only after a successful load", async () => {
    h.listPatients = () => Promise.resolve([]);
    h.listBeds = () => Promise.resolve(roster);
    renderBoard();
    expect(await screen.findByText(/No current ICU patients or outlying referrals\./)).toBeTruthy();
    expect(screen.getAllByText("Empty")).toHaveLength(3);
  });

  it("a filtered-out patient's bed stays occupied, and filtered-to-nothing is explained", async () => {
    h.search = { ...h.search, sex: "female" };
    h.listPatients = () => Promise.resolve([pt("a", "2", "male")]);
    h.listBeds = () => Promise.resolve(roster);
    renderBoard();
    expect(await screen.findByText(/No current patients match the current filters/)).toBeTruthy();
    expect(screen.getByText("Patient hidden by current filters")).toBeTruthy();
    expect(screen.getAllByText("Empty")).toHaveLength(2);
    expect(screen.getByText("(1/3 occupied)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });

  it("refresh failure keeps last good data, says how old it is, and stops claiming free beds", async () => {
    h.listPatients = () => Promise.resolve([pt("a", "1", "female")]);
    h.listBeds = () => Promise.resolve(roster);
    const { qc } = renderBoard();
    await screen.findByText("(1/3 occupied)");
    expect(screen.getAllByText("Empty")).toHaveLength(2);

    h.listPatients = () => Promise.reject(new Error("offline"));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["patients"] }).catch(() => {});
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The board couldn't refresh");
    expect(alert.textContent).toMatch(/ago\)/);
    expect(screen.queryByText("Empty")).toBeNull();
    expect(screen.getAllByText("Availability not confirmed")).toHaveLength(2);
    // Last good occupant is still visible.
    expect(screen.getByText(/1\/3 occupied/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("bed layout failure never shows beds as free; ICU patients are still listed", async () => {
    h.listPatients = () => Promise.resolve([pt("a", "1", "female")]);
    h.listBeds = () => Promise.reject(new Error("offline"));
    renderBoard();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The bed layout couldn't be loaded",
    );
    expect(screen.queryByText("Empty")).toBeNull();
  });
});
