import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  corsHeaders,
  json,
  authorizeBridge,
  logSync,
  logSecurityEvent,
  clientIp,
  consumeWriteNonce,
} from "@/lib/api-bridge.server";
import { writeAudit } from "@/lib/audit";
import { bridgeExport, isUuid } from "@/lib/bridge-exports.server";
import { getAdmin } from "@/lib/admin-db.server";
import { readBodyLimited } from "@/lib/request-body.server";
import {
  BRIDGE_INPUT_BOUNDS,
  BRIDGE_MAX_BODY_BYTES,
  findBoundsViolation,
} from "@/lib/input-bounds";

const investigationInsert = z.object({
  patient_id: z.string().uuid(),
  category: z.string().trim().min(1).max(100),
  findings: z.string().trim().min(1).max(20000),
  result_at: z.string().optional().nullable(),
});

export const Route = createFileRoute("/api/public/bridge/investigations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      // List investigations, filter by ?patient_id= and optional ?category=
      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/investigations");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const url = new URL(request.url);
        const patientId = url.searchParams.get("patient_id");
        const category = url.searchParams.get("category");

        // A patient id that is not a UUID can never match a shared patient.
        if (patientId !== null && !isUuid(patientId)) {
          await logSync(supabaseAdmin, {
            direction: "pull",
            entity: "investigations",
            record_count: 0,
            actor: auth.actor,
          });
          return json({ investigations: [] });
        }

        // Unit + still-shared parent checked in the same statement that reads
        // the rows (0008_bridge_read_exports.sql).
        const out = await bridgeExport(supabaseAdmin, "bridge_export_investigations", {
          _patient_id: patientId,
          _category: category,
        });
        if (!out.ok) return json({ error: "Service unavailable" }, out.status);
        await logSync(supabaseAdmin, {
          direction: "pull",
          entity: "investigations",
          record_count: out.rows.length,
          actor: auth.actor,
        });
        return json({ investigations: out.rows });
      },

      // Add a new investigation result (append-only)
      POST: async ({ request }) => {
        // Size cap before the body is buffered, signed or parsed.
        const body = await readBodyLimited(request, BRIDGE_MAX_BODY_BYTES);
        if (!body.ok) return json({ error: "Payload too large" }, 413);
        const rawBody = body.text;
        const auth = await authorizeBridge(
          request,
          rawBody,
          { write: true, roles: ["admin", "unit_admin", "clinician"] },
          "/bridge/investigations",
        );
        if (!auth.ok) return auth.response;

        const replayAdmin = await getAdmin();
        let fresh: boolean;
        try {
          fresh = await consumeWriteNonce(replayAdmin, auth.signature);
        } catch (e) {
          return (console.error("[bridge]", e), json({ error: "Internal server error" }, 500));
        }
        if (!fresh) {
          await logSecurityEvent(replayAdmin, {
            event_type: "replay_detected",
            endpoint: "/bridge/investigations",
            method: "POST",
            ip: clientIp(request),
            actor_role: auth.actor.role,
            actor_email: auth.actor.email ?? null,
          });
          return json({ error: "Replay detected" }, 409);
        }

        let parsed;
        try {
          const raw: unknown = JSON.parse(rawBody || "{}");
          // Oversized lists are refused before Zod 3 can expand them (GHSA-mrhx-c7xc-m3w5).
          if (findBoundsViolation(raw, BRIDGE_INPUT_BOUNDS)) {
            return json({ error: "Invalid investigation payload" }, 400);
          }
          parsed = investigationInsert.parse(raw);
        } catch {
          return json({ error: "Invalid investigation payload" }, 400);
        }

        const supabaseAdmin = await getAdmin();
        const { bridgeInsertInvestigation } = await import("@/lib/bridge-sharing.server");
        const outcome = await bridgeInsertInvestigation(supabaseAdmin, parsed);
        if (outcome.kind === "unavailable") return json({ error: "Service unavailable" }, 503);
        // Code only: a database error can echo request values.
        if (outcome.kind === "error")
          return (
            console.error("[bridge] investigation insert failed"),
            json({ error: "Internal server error" }, 500)
          );
        if (outcome.kind === "not_found") return json({ error: "Patient not found" }, 404);
        const data = outcome.row;
        await writeAudit(supabaseAdmin, {
          entity: "investigations",
          recordId: data["id"] as string,
          action: "insert",
          source: "bridge",
          actor: auth.actor,
          after: data,
        });
        await logSync(supabaseAdmin, {
          direction: "push",
          entity: "investigations",
          record_count: 1,
          actor: auth.actor,
        });
        return json({ investigation: data });
      },
    },
  },
});
