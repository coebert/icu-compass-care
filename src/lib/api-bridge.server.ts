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
    event_type: AuthFailureReason | "replay_detected" | "locked_out";
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

// Per-window request ceilings, keyed by client IP + method + endpoint. Reads
// are polled frequently by the partner bed board so they get a generous ceiling;
// writes are far rarer and get a tighter one to blunt automated abuse. Tune here.
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT_READ = 120;
const RATE_LIMIT_WRITE = 30;

export type RateLimitResult = { ok: true } | { ok: false; response: Response };

function tooMany(message: string, retryAfterSeconds: number): Response {
  const response = json({ error: message }, 429);
  response.headers.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
  return response;
}

/**
 * Record an abuse "strike" for a client IP. Repeated strikes within a rolling
 * window escalate into a temporary lockout (see register_bridge_strike). Returns
 * the lockout duration in seconds when this strike triggered/extended a lockout,
 * otherwise 0. Never throws — abuse accounting must not break request handling.
 */
export async function registerBridgeStrike(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  ip: string,
  reason: string,
): Promise<number> {
  try {
    const { data } = await admin.rpc("register_bridge_strike", { _ip: ip, _reason: reason });
    const row = Array.isArray(data) ? data[0] : data;
    return row && row.locked ? Number(row.retry_after) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Server-side rate limiting + temporary lockouts for a bridge request. Applied
 * BEFORE auth so an unauthenticated flood (bad signatures, probing) is throttled
 * too. Order per request:
 *   1. If the IP is currently locked out -> reject immediately (cheap fast path).
 *   2. Fixed-window rate limit. On breach, record a strike (which may escalate to
 *      a lockout) and reject.
 * Uses service-role-only tables via atomic RPCs. Fails OPEN on any limiter error
 * so a limiter outage can never take the clinical bridge down; sustained
 * limiting / lockouts are logged and feed the review-alert threshold.
 */
export async function enforceBridgeRateLimit(
  request: Request,
  endpoint: string,
  write: boolean,
): Promise<RateLimitResult> {
  try {
    const ip = clientIp(request) ?? "unknown";
    const { getAdmin } = await import("@/lib/admin-db.server");
    const admin = await getAdmin();

    // 1. Temporary lockout — block already-flagged abusers before any other work.
    try {
      const { data: lockData } = await admin.rpc("check_bridge_lockout", { _ip: ip });
      const lock = Array.isArray(lockData) ? lockData[0] : lockData;
      if (lock && lock.locked === true) {
        const retryAfter = Number(lock.retry_after) || 60;
        await logSecurityEvent(admin, {
          event_type: "locked_out",
          endpoint,
          method: request.method,
          ip,
          detail: `retry_after=${retryAfter}`,
        });
        return { ok: false, response: tooMany("Temporarily locked out", retryAfter) };
      }
    } catch {
      // fail open on lockout check
    }

    // 2. Fixed-window rate limit.
    const limit = write ? RATE_LIMIT_WRITE : RATE_LIMIT_READ;
    const bucketKey = `${ip}|${request.method}|${endpoint}`;
    const { data, error } = await admin.rpc("check_bridge_rate_limit", {
      _bucket_key: bucketKey,
      _limit: limit,
      _window_seconds: RATE_WINDOW_SECONDS,
    });
    if (error) return { ok: true }; // fail open — never let the limiter cause an outage
    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.allowed === false) {
      // A rate-limit breach is an abuse strike; repeated breaches lock the IP out.
      const lockSeconds = await registerBridgeStrike(admin, ip, "rate_limit");
      const retryAfter = lockSeconds > 0 ? lockSeconds : Number(row.retry_after) || RATE_WINDOW_SECONDS;
      await logSecurityEvent(admin, {
        event_type: lockSeconds > 0 ? "locked_out" : "rate_limited",
        endpoint,
        method: request.method,
        ip,
        detail: `count=${row.current_count} limit=${limit}`,
      });
      return {
        ok: false,
        response: tooMany(lockSeconds > 0 ? "Temporarily locked out" : "Rate limit exceeded", retryAfter),
      };
    }
    return { ok: true };
  } catch {
    return { ok: true }; // fail open
  }
}

/**
 * `authorize()` plus automatic rate limiting and security-event logging on
 * failure. Routes call this instead of `authorize()` so every bridge request is
 * throttled and every rejection is captured for review and threshold alerting.
 */
export async function authorizeBridge(
  request: Request,
  rawBody: string,
  opts: { write: boolean; roles?: readonly string[] },
  endpoint: string,
): Promise<AuthResult> {
  // Throttle first — this protects the unauthenticated attack surface too.
  const limited = await enforceBridgeRateLimit(request, endpoint, opts.write);
  if (!limited.ok) return { ok: false, response: limited.response, reason: "rate_limited" };

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
      // A bad HMAC signature is the classic brute-force / probing signature.
      // Count it as an abuse strike so repeated bad signatures lock the IP out.
      if (result.reason === "signature_failure") {
        await registerBridgeStrike(admin, clientIp(request) ?? "unknown", "signature_failure");
      }
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
