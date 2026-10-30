// Fail-closed session lock/state handling (pure: dependencies are injected so
// every error path is unit-testable).
//
// Rules:
//  - Cached clinical data is purged from memory BEFORE anything that can fail.
//  - A server error is never read as "active": it is "unknown", and the UI
//    blocks clinical content until the server confirms the state.
//  - A lock is only reported as protecting the session when the server
//    confirmed it. Otherwise the session is ended locally (verified fallback)
//    and the UI says so truthfully.
//  - Other tabs of the same browser are told to purge and lock too.

export type ServerSessionState = "active" | "locked" | "revoked" | "no_session";
export type SessionState = ServerSessionState | "unknown";

const KNOWN: readonly ServerSessionState[] = ["active", "locked", "revoked", "no_session"];

/** Interpret an RPC result. Errors, empty or unexpected payloads => "unknown". */
export function interpretSessionRpc(res: { data: unknown; error: unknown }): SessionState {
  if (res.error) return "unknown";
  return typeof res.data === "string" && (KNOWN as readonly string[]).includes(res.data)
    ? (res.data as ServerSessionState)
    : "unknown";
}

export type LockDeps = {
  /** Remove every cached query/result from memory (must not throw). */
  purgeCache: () => void | Promise<void>;
  /** Notify other tabs (best effort). */
  broadcast: (msg: SessionBroadcast) => void;
  rpcLock: () => Promise<{ data: unknown; error: unknown }>;
  rpcStatus: () => Promise<{ data: unknown; error: unknown }>;
  /** End the session on this device (revokes the refresh token when online). */
  signOutLocal: () => Promise<{ error: unknown } | void>;
};

export type LockOutcome =
  /** Server confirmed the lock; unlock needs a passkey or a fresh sign-in. */
  | { kind: "locked" }
  /** Server lock could not be confirmed; the session was ended on this device. */
  | { kind: "signed_out"; serverConfirmed: false; signOutError: boolean };

export type SessionBroadcast = { type: "lock" } | { type: "signed_out" };

export async function performLock(deps: LockDeps): Promise<LockOutcome> {
  await deps.purgeCache();
  try {
    deps.broadcast({ type: "lock" });
  } catch {
    /* best effort */
  }
  let state: SessionState = "unknown";
  try {
    state = interpretSessionRpc(await deps.rpcLock());
    if (state !== "locked") {
      // Verify independently rather than trusting a missing/odd reply.
      state = interpretSessionRpc(await deps.rpcStatus());
    }
  } catch {
    state = "unknown";
  }
  if (state === "locked") return { kind: "locked" };

  let signOutError = false;
  try {
    const r = await deps.signOutLocal();
    signOutError = Boolean(r && (r as { error: unknown }).error);
  } catch {
    signOutError = true;
  }
  try {
    deps.broadcast({ type: "signed_out" });
  } catch {
    /* best effort */
  }
  return { kind: "signed_out", serverConfirmed: false, signOutError };
}

/** What the UI must do for a polled/heartbeat state. */
export function uiActionFor(state: SessionState): "none" | "lock" | "sign_out" | "block_unknown" {
  switch (state) {
    case "active":
      return "none";
    case "locked":
      return "lock";
    case "revoked":
    case "no_session":
      return "sign_out";
    default:
      return "block_unknown";
  }
}

export const SESSION_CHANNEL = "icu-session";

export type ScopeTransition = "none" | "init" | "new_session" | "signed_out";

/**
 * Decide how the authenticated layout reacts to an auth event. A different
 * session id (e.g. password reauthentication creates a new session) must not
 * inherit the old session's lock state, inactivity deadline or cached data.
 */
export function scopeTransition(
  prevScope: string | null,
  event: string,
  nextScope: string | null,
): ScopeTransition {
  if (event === "SIGNED_OUT" || !nextScope) return prevScope ? "signed_out" : "none";
  if (!prevScope) return "init";
  return nextScope === prevScope ? "none" : "new_session";
}
