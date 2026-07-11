import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "crypto";
import { corsHeaders, json, authorize } from "@/lib/api-bridge.server";

/**
 * Self-test endpoint for cross-project HMAC signatures.
 *
 * It signs a canonical test envelope with the configured HANDOVER_API_SECRET
 * exactly the way a real caller does, then runs the same `authorize()` the
 * live bridge endpoints use to confirm the signature validates. It also proves
 * a tampered signature is rejected. No patient data is touched.
 *
 * GET  -> self-signs a synthetic request and reports whether it validates.
 * POST -> validates the signature on the request you actually send, so you can
 *         confirm signatures produced by the linked project verify here.
 */

const TEST_ACTOR = JSON.stringify({
  id: "00000000-0000-0000-0000-000000000000",
  email: "bridge-selftest@local",
  role: "clinician",
});

function sign(secret: string, timestamp: string, actor: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${actor}.${rawBody}`).digest("hex");
}

export const Route = createFileRoute("/api/public/bridge/verify-signature")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      // Self-signed round trip: sign a synthetic envelope with the current
      // secret, then verify it through the real authorize() path.
      GET: async () => {
        const secret = process.env.HANDOVER_API_SECRET;
        if (!secret) {
          return json(
            { ok: false, error: "HANDOVER_API_SECRET not configured", handover_api_secret_configured: false },
            503,
          );
        }

        const timestamp = String(Math.floor(Date.now() / 1000));
        const rawBody = "";
        const signature = sign(secret, timestamp, TEST_ACTOR, rawBody);

        const headers = {
          "x-timestamp": timestamp,
          "x-actor": TEST_ACTOR,
          "x-signature": signature,
          "Content-Type": "application/json",
        };

        const validReq = new Request("https://self/verify", { method: "GET", headers });
        const validResult = authorize(validReq, rawBody, { write: false });

        // Prove tampering is caught: flip a character in the signature.
        const tamperedSig = signature.slice(0, -1) + (signature.at(-1) === "0" ? "1" : "0");
        const tamperedReq = new Request("https://self/verify", {
          method: "GET",
          headers: { ...headers, "x-signature": tamperedSig },
        });
        const tamperedResult = authorize(tamperedReq, rawBody, { write: false });

        const passed = validResult.ok && !tamperedResult.ok;

        return json(
          {
            ok: passed,
            handover_api_secret_configured: true,
            rotation_window_active: Boolean(process.env.HANDOVER_API_SECRET_PREVIOUS),
            checks: {
              valid_signature_accepted: validResult.ok,
              tampered_signature_rejected: !tamperedResult.ok,
            },
            // NOTE: we intentionally do NOT return the signed timestamp/actor/
            // signature triple here. This route is unauthenticated, and a live,
            // working signature would be replayable against the real bridge
            // endpoints. Only the pass/fail result and message format are exposed.
            envelope: {
              message_format: "`${x-timestamp}.${x-actor}.${rawBody}`",
              raw_body: rawBody,
            },
            timestamp: new Date().toISOString(),
          },
          passed ? 200 : 500,
        );
      },

      // Validate a signature produced elsewhere (e.g. by the linked project).
      // Send the same headers a real bridge call uses; body is verified verbatim.
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const result = authorize(request, rawBody, { write: false });
        if (!result.ok) return result.response;
        return json({
          ok: true,
          signature_valid: true,
          actor: result.actor,
          timestamp: new Date().toISOString(),
        });
      },
    },
  },
});
