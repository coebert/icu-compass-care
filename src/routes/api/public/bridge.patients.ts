import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CORS_HEADERS, json, verifySignature } from "@/lib/api-bridge.server";

const patientUpsert = z.object({
  id: z.string().uuid().optional(),
  full_name: z.string().trim().min(1).max(200),
  hospital_number: z.string().trim().max(50).optional().nullable(),
  nhs_number: z.string().trim().max(50).optional().nullable(),
  dob: z.string().optional().nullable(),
  location_type: z.enum(["icu", "outlier"]).optional(),
  ward: z.string().trim().max(100).optional().nullable(),
  bed: z.string().trim().max(50).optional().nullable(),
  status: z.enum(["referred", "admitted", "discharged", "died"]).optional(),
  admission_date: z.string().optional().nullable(),
  discharge_date: z.string().optional().nullable(),
  discharge_destination: z.string().trim().max(300).optional().nullable(),
  date_of_death: z.string().optional().nullable(),
  past_medical_history: z.string().max(10000).optional().nullable(),
  current_admission: z.string().max(10000).optional().nullable(),
  current_management: z.string().max(10000).optional().nullable(),
  outstanding_tasks: z.string().max(10000).optional().nullable(),
  tep_in_place: z.boolean().optional(),
  tep_details: z.string().max(10000).optional().nullable(),
  dnacpr_decision: z.boolean().optional(),
  dnacpr_details: z.string().max(10000).optional().nullable(),
  dnacpr_date: z.string().optional().nullable(),
  nok_name: z.string().trim().max(200).optional().nullable(),
  nok_relationship: z.string().trim().max(100).optional().nullable(),
  nok_contact: z.string().trim().max(200).optional().nullable(),
  nok_last_updated: z.string().optional().nullable(),
  nok_last_updated_by: z.string().trim().max(200).optional().nullable(),
});

function cleanEmpty(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === "" ? null : v;
  return out;
}

export const Route = createFileRoute("/api/public/bridge/patients")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      // List patients (optionally filter by status via ?status=admitted)
      GET: async ({ request }) => {
        const authError = verifySignature(request, "");
        if (authError) return authError;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const url = new URL(request.url);
        const status = url.searchParams.get("status");

        let query = supabaseAdmin
          .from("patients")
          .select("*")
          .order("updated_at", { ascending: false });
        if (status) query = query.eq("status", status);

        const { data, error } = await query;
        if (error) return json({ error: error.message }, 500);
        return json({ patients: data });
      },

      // Create or update a patient (upsert by id when provided)
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const authError = verifySignature(request, rawBody);
        if (authError) return authError;

        let parsed;
        try {
          parsed = patientUpsert.parse(JSON.parse(rawBody || "{}"));
        } catch {
          return json({ error: "Invalid patient payload" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const record = cleanEmpty(parsed);

        const { data, error } = record.id
          ? await supabaseAdmin
              .from("patients")
              .update(record)
              .eq("id", record.id as string)
              .select()
              .maybeSingle()
          : await supabaseAdmin.from("patients").insert(record).select().maybeSingle();

        if (error) return json({ error: error.message }, 500);
        if (!data) return json({ error: "Patient not found" }, 404);
        return json({ patient: data });
      },
    },
  },
});
