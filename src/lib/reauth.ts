// Verified re-authentication for sensitive actions (admin account changes,
// passkey enrolment). The server decides from the signed token's `amr` stamp;
// the browser only collects the password and asks the auth service for a
// fresh session. Nothing here is trusted by the server.
import { supabase } from "@/integrations/supabase/client";

type Pending = { resolve: (ok: boolean) => void };
let pending: Pending | null = null;
const listeners = new Set<(open: boolean) => void>();

export function onReauthRequest(fn: (open: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function requestPassword(): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(false);
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { resolve };
    listeners.forEach((l) => l(true));
  });
}

export function finishReauth(ok: boolean) {
  const p = pending;
  pending = null;
  listeners.forEach((l) => l(false));
  p?.resolve(ok);
}

/** Confirm the signed-in user's password; returns true on success. */
export async function confirmPassword(password: string): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email;
  if (!email) return "You are not signed in.";
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? "That password is not correct." : null;
}

export function isReauthRequired(e: unknown): boolean {
  return e instanceof Error && e.message.includes("REAUTH_REQUIRED");
}

/** Run a sensitive action; if the server asks, confirm the password once and retry. */
export async function withReauth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isReauthRequired(e)) throw e;
    const ok = await requestPassword();
    if (!ok) throw new Error("Password confirmation is needed for this action.");
    return await fn();
  }
}
