// Real fail-closed lock logic (src/lib/session-lock.ts) with injected failures.
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { interpretSessionRpc, performLock, uiActionFor, type LockDeps } from "@/lib/session-lock";

function deps(over: Partial<LockDeps> = {}) {
  const calls: string[] = [];
  const d: LockDeps = {
    purgeCache: vi.fn(() => void calls.push("purge")),
    broadcast: vi.fn((m) => void calls.push(`broadcast:${m.type}`)),
    rpcLock: vi.fn(async () => (calls.push("lock"), { data: "locked", error: null })),
    rpcStatus: vi.fn(async () => (calls.push("status"), { data: "locked", error: null })),
    signOutLocal: vi.fn(async () => (calls.push("signout"), { error: null })),
    ...over,
  };
  return { d, calls };
}

describe("interpretSessionRpc", () => {
  it("never treats an error or odd payload as active", () => {
    expect(interpretSessionRpc({ data: null, error: { message: "500" } })).toBe("unknown");
    expect(interpretSessionRpc({ data: "active", error: { message: "x" } })).toBe("unknown");
    expect(interpretSessionRpc({ data: null, error: null })).toBe("unknown");
    expect(interpretSessionRpc({ data: "ACTIVE", error: null })).toBe("unknown");
    expect(interpretSessionRpc({ data: "active", error: null })).toBe("active");
  });
  it("unknown state blocks clinical content", () => {
    expect(uiActionFor("unknown")).toBe("block_unknown");
    expect(uiActionFor("revoked")).toBe("sign_out");
    expect(uiActionFor("locked")).toBe("lock");
  });
});

describe("performLock", () => {
  it("confirmed server lock => locked; cache purged before the network call", async () => {
    const { d, calls } = deps();
    expect(await performLock(d)).toEqual({ kind: "locked" });
    expect(calls[0]).toBe("purge");
    expect(calls).not.toContain("signout");
  });
  it("lock RPC error and status error => does NOT claim locked; signs out", async () => {
    const { d, calls } = deps({
      rpcLock: async () => ({ data: null, error: { message: "network" } }),
      rpcStatus: async () => ({ data: null, error: { message: "network" } }),
    });
    const r = await performLock(d);
    expect(r.kind).toBe("signed_out");
    expect(calls).toContain("signout");
    expect(calls).toContain("broadcast:signed_out");
  });
  it("lock RPC throws => signs out", async () => {
    const { d } = deps({ rpcLock: async () => Promise.reject(new Error("offline")) });
    expect((await performLock(d)).kind).toBe("signed_out");
  });
  it("lock reply missing but status independently confirms locked => locked", async () => {
    const { d } = deps({ rpcLock: async () => ({ data: null, error: null }) });
    expect(await performLock(d)).toEqual({ kind: "locked" });
  });
  it("server says active after lock attempt => not trusted as locked", async () => {
    const { d } = deps({
      rpcLock: async () => ({ data: "active", error: null }),
      rpcStatus: async () => ({ data: "active", error: null }),
    });
    expect((await performLock(d)).kind).toBe("signed_out");
  });
  it("reports a failed local sign-out truthfully", async () => {
    const { d } = deps({
      rpcLock: async () => ({ data: null, error: { message: "x" } }),
      rpcStatus: async () => ({ data: null, error: { message: "x" } }),
      signOutLocal: async () => ({ error: { message: "offline" } }),
    });
    expect(await performLock(d)).toEqual({ kind: "signed_out", serverConfirmed: false, signOutError: true });
  });
  it("purges cached patient data even when everything else fails", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["patients"], [{ id: "synthetic" }]);
    qc.setQueryData(["me"], { userId: "u" });
    const { d } = deps({
      purgeCache: () => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" }),
      rpcLock: async () => Promise.reject(new Error("x")),
      rpcStatus: async () => Promise.reject(new Error("x")),
      signOutLocal: async () => Promise.reject(new Error("x")),
    });
    await performLock(d);
    expect(qc.getQueryData(["patients"])).toBeUndefined();
  });
  it("tells other tabs to purge/lock first (cross-tab cached data)", async () => {
    const otherTab = new QueryClient();
    otherTab.setQueryData(["patients"], [{ id: "synthetic" }]);
    const bus: Array<(m: { type: string }) => void> = [
      (m) => {
        if (m.type === "lock" || m.type === "signed_out") otherTab.clear();
      },
    ];
    const { d } = deps({ broadcast: (m) => bus.forEach((l) => l(m)) });
    await performLock(d);
    expect(otherTab.getQueryData(["patients"])).toBeUndefined();
  });
});
