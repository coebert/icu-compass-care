// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useClinicalAccess } from "@/hooks/use-clinical-access";

/**
 * Unit tests for the UX clinical-access gate. `useClinicalAccess` is a thin
 * wrapper over the shared ["me"] query, so we stub the query layer and the
 * server function to drive it through its three "no access" states plus the
 * positive controls.
 */

// Stub the server function wrapper so the hook doesn't try to make a real RPC.
vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => vi.fn(),
}));

vi.mock("@/lib/me.functions", () => ({
  getMe: vi.fn(),
}));

// Controlled useQuery: each test sets what the ["me"] query resolves to.
const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("useClinicalAccess", () => {
  it("returns false while the profile is still loading", () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns false when the me profile is missing", () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: false });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(false);
  });

  // The hook reads the capability flags getMe derives from the role list
  // (canEditClinical / isTrustAdmin), not the raw role names.
  it("returns false for an auditor (no clinical rights)", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["auditor"], isAuditor: true, canEditClinical: false, isTrustAdmin: false },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(false);
  });

  it("returns false when the user has no roles", () => {
    useQueryMock.mockReturnValue({
      data: { roles: [], canEditClinical: false, isTrustAdmin: false },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(false);
  });

  it("returns true for a clinician", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["clinician"], canEditClinical: true, isTrustAdmin: false },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(true);
  });

  it("returns true for a unit administrator", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["unit_admin"], canEditClinical: true, isUnitAdmin: true },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(true);
  });

  // Trust administrators get break-glass VIEW rights only, but the read
  // surfaces this hook gates are still offered to them.
  it("returns true for a Trust administrator (view-only break-glass)", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["trust_admin"], canEditClinical: false, isTrustAdmin: true },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(true);
  });
});
