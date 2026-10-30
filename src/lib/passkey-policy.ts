// Pure rules for WebAuthn challenge binding (kept separate so they are unit-testable).

export type StoredChallenge = {
  challenge?: unknown;
  purpose?: unknown;
  session_id?: unknown;
  expires_at?: unknown;
};

/**
 * A stored challenge is usable only by the same auth session, for the same
 * purpose, before it expires. Rows written directly by a browser have no
 * session binding and are therefore never accepted.
 */
export function challengeIsValid(
  row: StoredChallenge | null | undefined,
  want: { sessionId: string; purpose: string },
  now: number = Date.now(),
): boolean {
  if (!row || typeof row.challenge !== "string" || !row.challenge) return false;
  if (row.purpose !== want.purpose) return false;
  if (typeof row.session_id !== "string" || row.session_id !== want.sessionId) return false;
  const exp = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
  if (!Number.isFinite(exp) || exp <= now) return false;
  return true;
}
