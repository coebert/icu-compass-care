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

  it("returns false for a non-clinical role", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["viewer"] },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(false);
  });

  it("returns false when the user has no roles", () => {
    useQueryMock.mockReturnValue({ data: { roles: [] }, isLoading: false });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(false);
  });

  it("returns true for a clinician", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["clinician"] },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(true);
  });

  it("returns true for an admin", () => {
    useQueryMock.mockReturnValue({
      data: { roles: ["admin"] },
      isLoading: false,
    });
    const { result } = renderHook(() => useClinicalAccess());
    expect(result.current.hasClinicalAccess).toBe(true);
  });
});
