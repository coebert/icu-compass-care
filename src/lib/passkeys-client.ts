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

export function passkeysSupported() {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

const ENROLLED_PREFIX = "icu-passkey-enrolled:";
const UNLOCKED_KEY = "icu-passkey-unlocked";

// Per-device flag: does THIS device hold a passkey for this user? Passkeys are
// device-bound, so we only lock devices that can actually satisfy the prompt.
export function deviceHasPasskey(userId: string) {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(ENROLLED_PREFIX + userId) === "1";
}

function setDevicePasskey(userId: string, enrolled: boolean) {
  if (typeof window === "undefined") return;
  if (enrolled) localStorage.setItem(ENROLLED_PREFIX + userId, "1");
  else localStorage.removeItem(ENROLLED_PREFIX + userId);
}

export function clearDevicePasskey(userId: string) {
  setDevicePasskey(userId, false);
  lockSession();
}

// Session-scoped unlock: cleared when the tab closes, so reopening the app
// requires biometric verification again.
export function isSessionUnlocked() {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(UNLOCKED_KEY) === "1";
}

export function markSessionUnlocked() {
  if (typeof window !== "undefined") sessionStorage.setItem(UNLOCKED_KEY, "1");
}

export function lockSession() {
  if (typeof window !== "undefined") sessionStorage.removeItem(UNLOCKED_KEY);
}

export async function registerPasskey(userId: string, deviceLabel?: string) {
  const options = await startPasskeyRegistration();
  const response = await startRegistration({ optionsJSON: options });
  await finishPasskeyRegistration({ data: { response, deviceLabel } });
  setDevicePasskey(userId, true);
  markSessionUnlocked();
}

export async function unlockWithPasskey() {
  const options = await startPasskeyUnlock();
  const response = await startAuthentication({ optionsJSON: options });
  await finishPasskeyUnlock({ data: { response } });
  markSessionUnlocked();
}
