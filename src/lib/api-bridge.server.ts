import { createHash, createHmac, timingSafeEqual } from "crypto";

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

// Restrict browser CORS to the partner app's origin instead of "*". The
// bridge is HMAC-gated so CORS is defence-in-depth, but scoping the origin
// removes cross-origin browser probing surface. Derived from PARTNER_BRIDGE_URL
// at call time (env is injected per-request on the worker runtime); falls back
// to "*" only when the partner origin is not configured.
function partnerOrigin(): string {
  const raw = process.env.PARTNER_BRIDGE_URL;
  if (!raw) return "*";
  try {
    return new URL(raw).origin;
  } catch {
    return "*";
  }
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": partnerOrigin(),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-timestamp, x-actor, x-signature",
    "Access-Control-Max-Age": "86400",
  };
}

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
      ...corsHeaders(),
    },
  });
}


const MAX_SKEW_SECONDS = 60;

// Roles recognised by the bridge.
const READ_ROLES = ["admin", "clinician"] as const;
const WRITE_ROLES = ["admin", "clinician"] as const;

export type BridgeActor = { id: string; email?: string; role: string };

// Entities exchanged across the bridge (clinical data plus occupancy/audit/
// notification read feeds).
export type BridgeEntity =
  | "patients"
  | "investigations"
  | "referrals"
  | "microbiology"
  | "beds"
  | "audit"
  | "notifications";

// Machine-readable classification of an authorization failure. Used for the
// security-event feed and threshold alerting.
export type AuthFailureReason =
  | "not_configured"
  | "missing_headers"
  | "stale_timestamp"
  | "signature_failure"
  | "invalid_actor"
  | "role_denied"
  | "rate_limited";

export type AuthResult =
  | { ok: true; actor: BridgeActor; signature: string }
  | {
      ok: false;
      response: Response;
      reason: AuthFailureReason;
      // Present only once the signed actor envelope has been parsed (role_denied).
      actor?: BridgeActor;
      detail?: string;
    };

/**
 * Verify the HMAC signature AND authorize the forwarded actor.
 * Pass `write: true` for state-changing requests to enforce write roles.
 * Pass `roles` to override the default allow-list for a specific endpoint.
 */
export function authorize(
  request: Request,
  rawBody: string,
  opts: { write: boolean; roles?: readonly string[] },
): AuthResult {
  // Accept the current secret and, during a rotation window, an optional
  // previous secret. This lets both projects roll over to a new value one at a
  // time without an outage: while HANDOVER_API_SECRET_PREVIOUS is set, requests
  // signed with either secret verify. Remove the previous secret once both
  // sides run the new one.
  const secrets = [process.env.HANDOVER_API_SECRET, process.env.HANDOVER_API_SECRET_PREVIOUS].filter(
    (s): s is string => Boolean(s),
  );
  if (secrets.length === 0)
    return { ok: false, response: json({ error: "Bridge not configured" }, 503), reason: "not_configured" };

  const timestamp = request.headers.get("x-timestamp");
  const actorHeader = request.headers.get("x-actor");
  const signature = request.headers.get("x-signature");
  if (!timestamp || !actorHeader || !signature) {
    return {
      ok: false,
      response: json({ error: "Missing authentication headers" }, 401),
      reason: "missing_headers",
    };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return {
      ok: false,
      response: json({ error: "Stale or invalid timestamp" }, 401),
      reason: "stale_timestamp",
      detail: `timestamp=${timestamp}`,
    };
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
    return {
      ok: false,
      response: json({ error: "Invalid signature" }, 401),
      reason: "signature_failure",
    };
  }

  // Actor is authenticated only because it is inside the signed envelope.
  let actor: BridgeActor;
  try {
    const parsed = JSON.parse(actorHeader) as Partial<BridgeActor>;
    if (!parsed.id || !parsed.role) throw new Error("incomplete");
    actor = { id: String(parsed.id), email: parsed.email ? String(parsed.email) : undefined, role: String(parsed.role) };
  } catch {
    return {
      ok: false,
      response: json({ error: "Missing or invalid user context" }, 401),
      reason: "invalid_actor",
    };
  }

  const allowed = opts.roles ?? (opts.write ? WRITE_ROLES : READ_ROLES);
  if (!(allowed as readonly string[]).includes(actor.role)) {
    return {
      ok: false,
      response: json({ error: "Insufficient role for this action" }, 403),
      reason: "role_denied",
      actor,
      detail: `role=${actor.role}`,
    };
  }

  return { ok: true, actor, signature };
}

/** Best-effort client IP from common proxy headers (for the security feed). */
export function clientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? null;
}

/**
 * Record a suspicious/failed bridge access attempt and let the database raise a
 * review alert when repeated signature failures or replay detections cross the
 * threshold. Never throws — security logging must not break request handling.
 */
export async function logSecurityEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  entry: {
    event_type: AuthFailureReason | "replay_detected";
    endpoint: string;
    method: string;
    ip?: string | null;
    actor_role?: string | null;
    actor_email?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  try {
    await admin.rpc("record_bridge_security_event", {
      _event_type: entry.event_type,
      _endpoint: entry.endpoint,
      _method: entry.method,
      _ip: entry.ip ?? null,
      _actor_role: entry.actor_role ?? null,
      _actor_email: entry.actor_email ?? null,
      _detail: entry.detail ?? null,
    });
  } catch {
    // swallow — security logging is best-effort
  }
}

/**
 * `authorize()` plus automatic security-event logging on failure. Routes should
 * call this instead of `authorize()` so every rejected bridge request is
 * captured for review and feeds the repeated-failure alerting.
 */
export async function authorizeBridge(
  request: Request,
  rawBody: string,
  opts: { write: boolean; roles?: readonly string[] },
  endpoint: string,
): Promise<AuthResult> {
  const result = authorize(request, rawBody, opts);
  if (!result.ok && result.reason !== "not_configured") {
    try {
      const { getAdmin } = await import("@/lib/admin-db.server");
      const admin = await getAdmin();
      await logSecurityEvent(admin, {
        event_type: result.reason,
        endpoint,
        method: request.method,
        ip: clientIp(request),
        actor_role: result.actor?.role ?? null,
        actor_email: result.actor?.email ?? null,
        detail: result.detail ?? null,
      });
    } catch {
      // swallow — never let auditing block the auth response
    }
  }
  return result;
}

/**
 * Replay guard for state-changing bridge requests. Records a one-time
 * fingerprint of the request's HMAC signature; a duplicate means the exact
 * same signed request is being replayed (only possible with a captured, still
 * in-window signature, since a fresh signature cannot be forged without the
 * secret). Returns true when the request is fresh, false when it is a replay.
 *
 * The signature already covers timestamp + actor + body, so its hash uniquely
 * identifies one signed request without needing a separate signed nonce field
 * (i.e. no change to the cross-project signing contract).
 */
export async function consumeWriteNonce(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  signature: string,
): Promise<boolean> {
  const signatureHash = createHash("sha256").update(signature).digest("hex");
  const { error } = await admin
    .from("bridge_write_nonces")
    .insert({ signature_hash: signatureHash });

  // Best-effort prune of fingerprints older than the replay window. A row older
  // than MAX_SKEW_SECONDS can never match a valid (in-window) timestamp again,
  // so it is safe to drop and keeps the table bounded.
  void admin
    .from("bridge_write_nonces")
    .delete()
    .lt("seen_at", new Date(Date.now() - (MAX_SKEW_SECONDS + 60) * 1000).toISOString())
    .then(() => undefined, () => undefined);

  if (!error) return true;
  // 23505 = unique_violation => this signature was already seen => replay.
  if ((error as { code?: string }).code === "23505") return false;
  // On any other storage error, fail closed: treat as not-fresh so a broken
  // replay store cannot silently disable replay protection for writes.
  throw new Error(`replay guard unavailable: ${(error as { message?: string }).message ?? "unknown"}`);
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
