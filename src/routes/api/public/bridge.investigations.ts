import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CORS_HEADERS, json, authorize, logSync, sharedPatientIds } from "@/lib/api-bridge.server";
import { writeAudit } from "@/lib/audit";
import { getAdmin } from "@/lib/admin-db.server";

const investigationInsert = z.object({
  patient_id: z.string().uuid(),
  category: z.string().trim().min(1).max(100),
  findings: z.string().trim().min(1).max(20000),
  result_at: z.string().optional().nullable(),
});

export const Route = createFileRoute("/api/public/bridge/investigations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      // List investigations, filter by ?patient_id= and optional ?category=
      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const url = new URL(request.url);
        const patientId = url.searchParams.get("patient_id");
        const category = url.searchParams.get("category");

        let query = supabaseAdmin
          .from("investigations")
          .select("*")
          .order("result_at", { ascending: false });
        if (patientId) query = query.eq("patient_id", patientId);
        if (category) query = query.eq("category", category);

        const { data, error } = await query;
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        await logSync(supabaseAdmin, { direction: "pull", entity: "investigations", record_count: data?.length ?? 0, actor: auth.actor });
        return json({ investigations: data });
      },

      // Add a new investigation result (append-only)
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const auth = authorize(request, rawBody, { write: true });
        if (!auth.ok) return auth.response;

        let parsed;
        try {
          parsed = investigationInsert.parse(JSON.parse(rawBody || "{}"));
        } catch {
          return json({ error: "Invalid investigation payload" }, 400);
        }

        const supabaseAdmin = await getAdmin();
        const record = { ...parsed, result_at: parsed.result_at || new Date().toISOString() };

        const { data, error } = await supabaseAdmin
          .from("investigations")
          .insert(record)
          .select()
          .maybeSingle();

        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        if (data) {
          await writeAudit(supabaseAdmin, {
            entity: "investigations",
            recordId: data.id,
            action: "insert",
            source: "bridge",
            actor: auth.actor,
            after: data as Record<string, unknown>,
          });
        }
        await logSync(supabaseAdmin, { direction: "push", entity: "investigations", record_count: 1, actor: auth.actor });
        return json({ investigation: data });
      },
    },
  },
});
