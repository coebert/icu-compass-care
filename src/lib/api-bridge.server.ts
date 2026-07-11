import { createHmac, timingSafeEqual } from "crypto";

/**
 * Shared HMAC auth + RBAC for the cross-project data bridge.
 *
 * The two apps run on separate backends, so the bridge cannot validate the
 * other app's user session directly. Instead the trusted caller (proven by the
 * HMAC signature) forwards the signed-in user's identity and role in a SIGNED
 * actor envelope. The bridge:
 *   1. verifies the HMAC signature  -> request came from the trusted app
 *   2. requires a valid actor       -> a real logged-in user is acting
 *   3. checks the actor's role       -> role-based access control
 *
 * Signing (done by the caller):
 *   actor     = JSON string { id, email, role }   (sent as the x-actor header)
 *   message   = `${timestamp}.${actor}.${rawBody}` (rawBody is "" for GET)
 *   signature = hex( HMAC_SHA256(HANDOVER_API_SECRET, message) )
 *
 * Headers:
 *   x-timestamp: <unix seconds>
 *   x-actor:     <JSON { id, email, role }>
 *   x-signature: <hex signature>
 */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-timestamp, x-actor, x-signature",
  "Access-Control-Max-Age": "86400",
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Bridge payloads are live clinical/occupancy snapshots polled from a
      // stable public URL. Without this, the CDN/browser can cache a response
      // and the partner app's bed board keeps showing a stale snapshot (looks
      // like it "stopped updating"). Force every response to be revalidated.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      ...CORS_HEADERS,
    },
  });
}


const MAX_SKEW_SECONDS = 300;

// Roles recognised by the bridge.
const READ_ROLES = ["admin", "clinician"] as const;
const WRITE_ROLES = ["admin", "clinician"] as const;

export type BridgeActor = { id: string; email?: string; role: string };

// Clinical entities reconciled across the bridge.
export type BridgeEntity = "patients" | "investigations" | "referrals" | "microbiology";

export type AuthResult =
  | { ok: true; actor: BridgeActor }
  | { ok: false; response: Response };

/**
 * Verify the HMAC signature AND authorize the forwarded actor.
 * Pass `write: true` for state-changing requests to enforce write roles.
 */
export function authorize(
  request: Request,
  rawBody: string,
  opts: { write: boolean },
): AuthResult {
  // Accept the current secret and, during a rotation window, an optional
  // previous secret. This lets both projects roll over to a new value one at a
  // time without an outage: while HANDOVER_API_SECRET_PREVIOUS is set, requests
  // signed with either secret verify. Remove the previous secret once both
  // sides run the new one.
  const secrets = [process.env.HANDOVER_API_SECRET, process.env.HANDOVER_API_SECRET_PREVIOUS].filter(
    (s): s is string => Boolean(s),
  );
  if (secrets.length === 0) return { ok: false, response: json({ error: "Bridge not configured" }, 503) };

  const timestamp = request.headers.get("x-timestamp");
  const actorHeader = request.headers.get("x-actor");
  const signature = request.headers.get("x-signature");
  if (!timestamp || !actorHeader || !signature) {
    return { ok: false, response: json({ error: "Missing authentication headers" }, 401) };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, response: json({ error: "Stale or invalid timestamp" }, 401) };
  }

  // Verify the signature over the exact bytes (including the actor envelope)
  // against each accepted secret with a timing-safe compare.
  const sigBuf = Buffer.from(signature);
  const signatureValid = secrets.some((secret) => {
    const expBuf = Buffer.from(
      createHmac("sha256", secret).update(`${timestamp}.${actorHeader}.${rawBody}`).digest("hex"),
    );
    return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  });
  if (!signatureValid) {
    return { ok: false, response: json({ error: "Invalid signature" }, 401) };
  }

  // Actor is authenticated only because it is inside the signed envelope.
  let actor: BridgeActor;
  try {
    const parsed = JSON.parse(actorHeader) as Partial<BridgeActor>;
    if (!parsed.id || !parsed.role) throw new Error("incomplete");
    actor = { id: String(parsed.id), email: parsed.email ? String(parsed.email) : undefined, role: String(parsed.role) };
  } catch {
    return { ok: false, response: json({ error: "Missing or invalid user context" }, 401) };
  }

  const allowed = opts.write ? WRITE_ROLES : READ_ROLES;
  if (!(allowed as readonly string[]).includes(actor.role)) {
    return { ok: false, response: json({ error: "Insufficient role for this action" }, 403) };
  }

  return { ok: true, actor };
}

/**
 * Record a successful bridge exchange for the "Sync status" panel.
 * `direction`: "push" = data written into this app, "pull" = data read out.
 * Never throws — logging failures must not break the actual data operation.
 */
export async function logSync(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  entry: {
    direction: "push" | "pull";
    entity: BridgeEntity;
    record_count: number;
    actor: BridgeActor;
  },
): Promise<void> {
  try {
    await admin.from("bridge_sync_events").insert({
      direction: entry.direction,
      entity: entry.entity,
      record_count: entry.record_count,
      actor_role: entry.actor.role,
      actor_email: entry.actor.email ?? null,
      status: "success",
    });
  } catch {
    // swallow — sync logging is best-effort
  }
}

/**
 * Record a FAILED bridge exchange so the "Sync status" panel can surface the
 * last error. Never throws — logging failures must not mask the real error.
 */
export async function logSyncError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  entry: {
    direction: "push" | "pull";
    entity: BridgeEntity;
    message: string;
    actor: BridgeActor;
  },
): Promise<void> {
  try {
    await admin.from("bridge_sync_events").insert({
      direction: entry.direction,
      entity: entry.entity,
      record_count: 0,
      actor_role: entry.actor.role,
      actor_email: entry.actor.email ?? null,
      status: "error",
      error_message: entry.message.slice(0, 1000),
    });
  } catch {
    // swallow — sync logging is best-effort
  }
}

// Returns the set of patient ids an administrator has marked as shared with the
// partner app. Child clinical entities (investigations, microbiology) must be
// gated to this set so PHI for non-shared patients never leaves this backend.
export async function sharedPatientIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
): Promise<string[]> {
  const { data, error } = await admin
    .from("patients")
    .select("id")
    .eq("shared_with_partner", true);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { id: string }) => r.id);
}
