import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeBridge,
  clientIp,
  consumeWriteNonce,
  corsHeaders,
  json,
  logSecurityEvent,
  logSync,
} from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";
import { readBodyLimited } from "@/lib/request-body.server";
import { parseWardableRequest, wardableHttp } from "@/lib/bridge-wardable";

// Fenced "ready for ward" update from Critical Care Connect.
// Request: exactly {id, expected_updated_at, wardable, desired_revision}.
// See docs/bridge/wardable-protocol.md for the full contract. The database
// helper (staged 0007) does every check and write in one transaction.
const MAX_BODY_BYTES = 2048;

export const Route = createFileRoute("/api/public/bridge/patients_/wardable")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      POST: async ({ request }) => {
        const body = await readBodyLimited(request, MAX_BODY_BYTES);
        if (!body.ok) return json({ ok: false, code: "invalid_request" }, 413);
        const auth = await authorizeBridge(
          request,
          body.text,
          { write: true, roles: ["admin", "unit_admin", "clinician"] },
          "/bridge/patients/wardable",
        );
        if (!auth.ok) return auth.response;

        const admin = await getAdmin();
        let fresh: boolean;
        try {
          fresh = await consumeWriteNonce(admin, auth.signature);
        } catch {
          return json({ ok: false, code: "unavailable" }, 503);
        }
        if (!fresh) {
          await logSecurityEvent(admin, {
            event_type: "replay_detected",
            endpoint: "/bridge/patients/wardable",
            method: "POST",
            ip: clientIp(request),
            actor_role: auth.actor.role,
            actor_email: auth.actor.email ?? null,
          });
          // 401, not 409: the 409 codes are reserved for the fence outcomes.
          return json({ ok: false, code: "replay" }, 401);
        }

        let raw: unknown;
        try {
          raw = JSON.parse(body.text || "null");
        } catch {
          return json({ ok: false, code: "invalid_request" }, 400);
        }
        const req = parseWardableRequest(raw);
        if (!req) return json({ ok: false, code: "invalid_request" }, 400);

        const { data, error } = await admin.rpc("bridge_set_wardable" as never, {
          _patient_id: req.id,
          _expected_updated_at: req.expected_updated_at,
          _wardable: req.wardable,
          // Decimal string end to end: never through a JS number.
          _desired_revision: req.desired_revision,
          // The actor comes from the verified signed envelope only.
          _actor: { id: auth.actor.id, email: auth.actor.email ?? null, role: auth.actor.role },
        } as never);
        if (error) {
          const code = (error as { code?: string }).code;
          if (code === "PT400") return json({ ok: false, code: "invalid_request" }, 400);
          // Code only — never request values or database text.
          console.error("[bridge] wardable update unavailable", code ?? "unknown");
          return json({ ok: false, code: "unavailable" }, 503);
        }
        const out = wardableHttp(data);
        if (out.status === 200) {
          await logSync(admin, { direction: "push", entity: "patients", record_count: 1, actor: auth.actor });
        }
        return json(out.body, out.status);
      },
    },
  },
});
