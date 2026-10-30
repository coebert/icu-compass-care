import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import {
  startPasskeyRegistration,
  finishPasskeyRegistration,
  startPasskeyUnlock,
  finishPasskeyUnlock,
} from "@/lib/passkeys.functions";
import { supabase } from "@/integrations/supabase/client";

export function passkeysSupported() {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

const ENROLLED_PREFIX = "icu-passkey-enrolled:";

// Per-device HINT: does THIS device hold a passkey for this user? It only
// decides whether to OFFER passkey unlock. It is never an authority: whether a
// session is locked is held server-side (session_guard) and enforced by the
// database on every role-gated read/write.
export function deviceHasPasskey(userId: string) {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ENROLLED_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

function setDevicePasskey(userId: string, enrolled: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (enrolled) localStorage.setItem(ENROLLED_PREFIX + userId, "1");
    else localStorage.removeItem(ENROLLED_PREFIX + userId);
  } catch {
    /* storage unavailable: passkey unlock simply isn't offered */
  }
}

export function clearDevicePasskey(userId: string) {
  setDevicePasskey(userId, false);
}

export type { SessionState } from "@/lib/session-lock";
import { interpretSessionRpc, type SessionState } from "@/lib/session-lock";

/** Ask the server for this session's lock state. Errors => "unknown" (fail closed). */
export async function fetchSessionState(): Promise<SessionState> {
  try {
    return interpretSessionRpc(await supabase.rpc("session_status"));
  } catch {
    return "unknown";
  }
}

/** Record genuine user activity; never revives a locked/idle session. */
export async function sessionHeartbeat(): Promise<SessionState> {
  try {
    return interpretSessionRpc(await supabase.rpc("session_heartbeat"));
  } catch {
    return "unknown";
  }
}

/** Raw lock/status RPCs for performLock (src/lib/session-lock.ts). */
export const sessionRpc = {
  lock: async () => supabase.rpc("session_lock"),
  status: async () => supabase.rpc("session_status"),
};

export async function registerPasskey(userId: string, deviceLabel?: string) {
  const { withReauth } = await import("@/lib/reauth");
  const options = await withReauth(() => startPasskeyRegistration());
  const response = await startRegistration({ optionsJSON: options });
  await finishPasskeyRegistration({ data: { response, deviceLabel } });
  setDevicePasskey(userId, true);
}

/** Verified passkey assertion -> the server clears this session's lock. */
export async function unlockWithPasskey() {
  const options = await startPasskeyUnlock();
  const response = await startAuthentication({ optionsJSON: options });
  await finishPasskeyUnlock({ data: { response } });
}
