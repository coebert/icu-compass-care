import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CORS_HEADERS, json, authorize, logSync } from "@/lib/api-bridge.server";
import { writeAudit } from "@/lib/audit";

const patientUpsert = z.object({
  id: z.string().uuid().optional(),
  // Optimistic concurrency: the updated_at the caller last saw. When present on
  // an update, the write is rejected (409) if the record changed since then.
  expected_updated_at: z.string().optional(),
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

function cleanEmpty<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === "" ? null : v;
  return out as T;
}

export const Route = createFileRoute("/api/public/bridge/patients")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),

      // List patients (optionally filter by status via ?status=admitted)
      GET: async ({ request }) => {
        const auth = authorize(request, "", { write: false });
        if (!auth.ok) return auth.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const url = new URL(request.url);
        const status = url.searchParams.get("status");

        let query = supabaseAdmin
          .from("patients")
          .select("*")
          .order("updated_at", { ascending: false });
        if (status) query = query.eq("status", status as "admitted" | "died" | "discharged" | "referred");

        const { data, error } = await query;
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        await logSync(supabaseAdmin, { direction: "pull", entity: "patients", record_count: data?.length ?? 0, actor: auth.actor });
        return json({ patients: data });
      },

      // Create or update a patient (upsert by id when provided)
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const auth = authorize(request, rawBody, { write: true });
        if (!auth.ok) return auth.response;

        let parsed;
        try {
          parsed = patientUpsert.parse(JSON.parse(rawBody || "{}"));
        } catch {
          return json({ error: "Invalid patient payload" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // Strip control fields that are not table columns.
        const { expected_updated_at, ...columns } = parsed;
        const record = cleanEmpty(columns);

        if (record.id) {
          // Load the current row for conflict detection + audit "before" snapshot.
          const { data: current, error: readErr } = await supabaseAdmin
            .from("patients")
            .select("*")
            .eq("id", record.id as string)
            .maybeSingle();
          if (readErr) return (console.error("[bridge]", readErr), json({ error: "Internal server error" }, 500));
          if (!current) return json({ error: "Patient not found" }, 404);

          // Optimistic concurrency: reject stale writes so the caller can reconcile.
          if (expected_updated_at && current.updated_at !== expected_updated_at) {
            return json(
              {
                error: "conflict",
                message: "This patient was modified since you last loaded it.",
                current,
                your_expected_updated_at: expected_updated_at,
              },
              409,
            );
          }

          const { data, error } = await supabaseAdmin
            .from("patients")
            .update(record)
            .eq("id", record.id as string)
            .select()
            .maybeSingle();
          if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
          if (!data) return json({ error: "Patient not found" }, 404);

          await writeAudit(supabaseAdmin, {
            entity: "patients",
            recordId: data.id,
            action: "update",
            source: "bridge",
            actor: auth.actor,
            before: current as Record<string, unknown>,
            after: data as Record<string, unknown>,
          });
          await logSync(supabaseAdmin, { direction: "push", entity: "patients", record_count: 1, actor: auth.actor });
          return json({ patient: data });
        }

        const { data, error } = await supabaseAdmin
          .from("patients")
          .insert(record)
          .select()
          .maybeSingle();
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        if (!data) return json({ error: "Patient could not be created" }, 500);

        await writeAudit(supabaseAdmin, {
          entity: "patients",
          recordId: data.id,
          action: "insert",
          source: "bridge",
          actor: auth.actor,
          after: data as Record<string, unknown>,
        });
        await logSync(supabaseAdmin, { direction: "push", entity: "patients", record_count: 1, actor: auth.actor });
        return json({ patient: data });
      },
    },
  },
});
