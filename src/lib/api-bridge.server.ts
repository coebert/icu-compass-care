import { createHmac, timingSafeEqual } from "crypto";

/**
 * Shared HMAC auth + CORS for the cross-project data bridge.
 *
 * The calling project signs each request:
 *   message   = `${timestamp}.${rawBody}`   (rawBody is "" for GET)
 *   signature = hex( HMAC_SHA256(HANDOVER_API_SECRET, message) )
 *
 * Sent as headers:
 *   x-timestamp: <unix seconds>
 *   x-signature: <hex signature>
 */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-timestamp, x-signature",
  "Access-Control-Max-Age": "86400",
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const MAX_SKEW_SECONDS = 300;

/**
 * Verify the HMAC signature of an incoming request. Returns null when valid,
 * or a ready-to-return error Response when invalid.
 */
export function verifySignature(request: Request, rawBody: string): Response | null {
  const secret = process.env.HANDOVER_API_SECRET;
  if (!secret) {
    return json({ error: "Bridge not configured" }, 503);
  }

  const timestamp = request.headers.get("x-timestamp");
  const signature = request.headers.get("x-signature");
  if (!timestamp || !signature) {
    return json({ error: "Missing authentication headers" }, 401);
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return json({ error: "Stale or invalid timestamp" }, 401);
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return json({ error: "Invalid signature" }, 401);
  }

  return null;
}
