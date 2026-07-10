import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CORS_HEADERS, json, verifySignature } from "@/lib/api-bridge.server";

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
        const authError = verifySignature(request, "");
        if (authError) return authError;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
        if (error) return json({ error: error.message }, 500);
        return json({ investigations: data });
      },

      // Add a new investigation result (append-only)
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const authError = verifySignature(request, rawBody);
        if (authError) return authError;

        let parsed;
        try {
          parsed = investigationInsert.parse(JSON.parse(rawBody || "{}"));
        } catch {
          return json({ error: "Invalid investigation payload" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const record = { ...parsed, result_at: parsed.result_at || new Date().toISOString() };

        const { data, error } = await supabaseAdmin
          .from("investigations")
          .insert(record)
          .select()
          .maybeSingle();

        if (error) return json({ error: error.message }, 500);
        return json({ investigation: data });
      },
    },
  },
});
