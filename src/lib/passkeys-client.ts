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

export type SessionState = "active" | "locked" | "revoked" | "no_session";

/** Ask the server for this session's lock state (read-only). */
export async function fetchSessionState(): Promise<SessionState> {
  const { data, error } = await supabase.rpc("session_status");
  if (error) return "active"; // transient: the database still enforces the lock
  return (data as SessionState) ?? "active";
}

/** Record genuine user activity; never revives a locked/idle session. */
export async function sessionHeartbeat(): Promise<SessionState> {
  const { data, error } = await supabase.rpc("session_heartbeat");
  if (error) return "active";
  return (data as SessionState) ?? "active";
}

/** Lock this session on the server. Unlock needs a verified passkey or a fresh sign-in. */
export async function lockSessionOnServer(): Promise<void> {
  await supabase.rpc("session_lock");
}

export async function registerPasskey(userId: string, deviceLabel?: string) {
  const options = await startPasskeyRegistration();
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
