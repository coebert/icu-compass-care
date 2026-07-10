import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "crypto";

/**
 * End-to-end test: tampering with a signed envelope is rejected.
 *
 * A caller signs the canonical envelope `${timestamp}.${actor}.${body}` with the
 * shared HANDOVER_API_SECRET. This test signs a valid envelope, then mutates ONE
 * field of the payload AFTER signing (without re-signing) and confirms the bridge
 * rejects it with HTTP 401 "Invalid signature" — proving the signature actually
 * binds the payload and any single-field change invalidates it.
 *
 * Requires:
 *   HANDOVER_API_SECRET  — shared HMAC secret (same value on both backends)
 *   BRIDGE_BASE_URL      — base URL to hit (defaults to local dev server)
 *
 * Run:  HANDOVER_API_SECRET=... bunx vitest run tests/bridge-tamper.test.ts
 */

const BASE_URL = process.env.BRIDGE_BASE_URL ?? "http://localhost:8080";
const SECRET = process.env.HANDOVER_API_SECRET ?? "";
const VERIFY_PATH = "/api/public/bridge/verify-signature";

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sign(timestamp: string, actor: string, body: string): string {
  return createHmac("sha256", SECRET).update(`${timestamp}.${actor}.${body}`).digest("hex");
}

async function postEnvelope(opts: { timestamp: string; actor: string; body: string; signature: string }) {
  const res = await fetch(`${BASE_URL}${VERIFY_PATH}`, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Content-Type": "application/json",
      "x-timestamp": opts.timestamp,
      "x-actor": opts.actor,
      "x-signature": opts.signature,
    },
    body: opts.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON — leave null */
  }
  return { status: res.status, json, text };
}

describe("bridge signed-envelope tamper detection (e2e)", () => {
  beforeAll(() => {
    if (!SECRET) {
      throw new Error(
        "HANDOVER_API_SECRET is required to run this test. Set it in the environment before running vitest.",
      );
    }
  });

  it("accepts an intact signed envelope, then rejects it once a body field is changed", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const actor = JSON.stringify({
      id: "00000000-0000-0000-0000-000000000002",
      email: "bridge-tamper@sdh.nhs",
      role: "clinician",
    });
    const originalPayload = { full_name: "Z.Q.", age: 72, hospital_number: `TAMPER-${Date.now()}` };
    const body = JSON.stringify(originalPayload);

    // Sign the intact envelope.
    const signature = sign(timestamp, actor, body);

    // 1. Sanity check: the intact envelope verifies.
    const intact = await postEnvelope({ timestamp, actor, body, signature });
    expect(intact.status, `intact envelope should verify: ${intact.text}`).toBe(200);
    expect((intact.json as { signature_valid?: boolean })?.signature_valid).toBe(true);

    // 2. Change ONE field in the payload but keep the ORIGINAL signature.
    const tamperedBody = JSON.stringify({ ...originalPayload, age: 99 });
    expect(tamperedBody).not.toBe(body);

    const tampered = await postEnvelope({ timestamp, actor, body: tamperedBody, signature });

    // The bridge must reject the tampered payload as an invalid signature.
    expect(tampered.status, `tampered envelope should be rejected: ${tampered.text}`).toBe(401);
    expect((tampered.json as { error?: string })?.error).toBe("Invalid signature");
    // It must NOT report the tampered payload as valid.
    expect((tampered.json as { signature_valid?: boolean })?.signature_valid).not.toBe(true);
  });
});
