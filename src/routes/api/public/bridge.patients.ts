import { createFileRoute } from "@tanstack/react-router";
import {
  decryptPatientRow,
  decryptPatientRows,
  encryptPatientPayload,
} from "@/lib/patient-crypto.server";
import { z } from "zod";
import { corsHeaders, json, authorizeBridge, logSync, logSecurityEvent, clientIp, consumeWriteNonce } from "@/lib/api-bridge.server";
import { diffFields, writeAudit } from "@/lib/audit";
import { clean, PATIENT_ARRAY_FIELDS } from "@/lib/patient-schema";
import { getAdmin } from "@/lib/admin-db.server";

// The bridge deliberately keeps a LOOSER schema than the app (see patient-schema.ts):
// the partner system is trusted, may send longer names, treats every field as
// optional, and is not subject to the app's status-transition rules. The structured
// fields are spread in from PATIENT_ARRAY_FIELDS so this stays in step with the app
// model whenever new structured fields are added.
const patientUpsert = z.object({
  id: z.string().uuid().optional(),
  // Optimistic concurrency: the updated_at the caller last saw. When present on
  // an update, the write is rejected (409) if the record changed since then.
  expected_updated_at: z.string().optional(),
  // This app stores patient INITIALS ONLY. The partner system may still send a
  // longer name, so anything that isn't already initials is reduced to initials
  // here, before it ever reaches the database (which also enforces the rule).
  full_name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((v) => toInitials(v)),
  hospital_number: z.string().trim().max(50).optional().nullable(),
  age: z.coerce.number().int().min(0).max(130).optional().nullable(),
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
  systems_resp: z.string().max(10000).optional().nullable(),
  resp_fio2: z.string().max(50).optional().nullable(),
  systems_cvs: z.string().max(10000).optional().nullable(),
  systems_neuro: z.string().max(10000).optional().nullable(),
  systems_renal: z.string().max(10000).optional().nullable(),
  systems_gastro: z.string().max(10000).optional().nullable(),
  systems_haem: z.string().max(10000).optional().nullable(),
  systems_micro: z.string().max(10000).optional().nullable(),
  systems_other: z.string().max(10000).optional().nullable(),
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
  // Ready-for-ward marker + server-stamped transition timestamps. Sent
  // across the bridge so the partner app sees the same wait-time signal.
  wardable: z.boolean().optional(),
  wardable_at: z.string().optional().nullable(),
  wardable_by: z.string().trim().max(200).optional().nullable(),
  // Structured clinical fields, kept in sync with the app model.
  ...PATIENT_ARRAY_FIELDS,
});


export const Route = createFileRoute("/api/public/bridge/patients")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      // List patients (optionally filter by status via ?status=admitted)
      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/patients");
        if (!auth.ok) return auth.response;

        const supabaseAdmin = await getAdmin();
        const url = new URL(request.url);
        const status = url.searchParams.get("status");

        let query = supabaseAdmin
          .from("patients")
          .select("*")
          // Only patients an administrator has explicitly marked as shared are
          // ever exposed across the bridge. This is the governance gate for
          // cross-project PHI sharing.
          .eq("shared_with_partner", true)
          .order("updated_at", { ascending: false });
        if (status) query = query.eq("status", status as "admitted" | "died" | "discharged" | "referred");

        const { data, error } = await query;
        if (error) return (console.error("[bridge]", error), json({ error: "Internal server error" }, 500));
        // The sharing flag is a local governance decision, not clinical data —
        // never leak it to the partner (and never let it overwrite their copy).
        const patients = decryptPatientRows(
          data as Array<Record<string, unknown>> | null,
        ).map((p: Record<string, unknown>) => {
          const { shared_with_partner, shared_with_partner_at, shared_with_partner_by, ...rest } = p;
          void shared_with_partner;
          void shared_with_partner_at;
          void shared_with_partner_by;
          return rest;
        });
        await logSync(supabaseAdmin, { direction: "pull", entity: "patients", record_count: patients.length, actor: auth.actor });
        return json({ patients });
      },


      // Create or update a patient (upsert by id when provided)
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const auth = await authorizeBridge(request, rawBody, { write: true, roles: ["admin", "clinician"] }, "/bridge/patients");
        if (!auth.ok) return auth.response;

        const supabaseAdminReplay = await getAdmin();
        let fresh: boolean;
        try {
          fresh = await consumeWriteNonce(supabaseAdminReplay, auth.signature);
        } catch (e) {
          return (console.error("[bridge]", e), json({ error: "Internal server error" }, 500));
        }
        if (!fresh) {
          await logSecurityEvent(supabaseAdminReplay, {
            event_type: "replay_detected",
            endpoint: "/bridge/patients",
            method: "POST",
            ip: clientIp(request),
            actor_role: auth.actor.role,
            actor_email: auth.actor.email ?? null,
          });
          return json({ error: "Replay detected" }, 409);
        }

        let parsed;
        try {
          parsed = patientUpsert.parse(JSON.parse(rawBody || "{}"));
        } catch {
          return json({ error: "Invalid patient payload" }, 400);
        }

        const supabaseAdmin = await getAdmin();
        // Strip control fields that are not table columns.
        const { expected_updated_at, ...columns } = parsed;
        const record = clean(columns);

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
                current: decryptPatientRow(current as Record<string, unknown>),
                your_expected_updated_at: expected_updated_at,
              },
              409,
            );
          }

          const { data, error } = await supabaseAdmin
            .from("patients")
            .update(encryptPatientPayload(record) as never)
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
            // Ciphertext can't be diffed byte-wise; compare readable values.
            changedFields: diffFields(
              decryptPatientRow(current as Record<string, unknown>),
              decryptPatientRow(data as Record<string, unknown>),
            ),
          });
          await logSync(supabaseAdmin, { direction: "push", entity: "patients", record_count: 1, actor: auth.actor });
          return json({ patient: decryptPatientRow(data as Record<string, unknown>) });
        }

        // Bridge writes are unit-scoped too: partner pushes land in the local
        // unit unless the payload names one explicitly.
        const { defaultUnitId } = await import("@/lib/scope.server");
        const bridgeUnitId =
          (record as Record<string, unknown>)["unit_id"] ?? (await defaultUnitId(supabaseAdmin));
        const { data, error } = await supabaseAdmin
          .from("patients")
          .insert(encryptPatientPayload({ ...record, unit_id: bridgeUnitId }) as never)
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
        return json({ patient: decryptPatientRow(data as Record<string, unknown>) });
      },
    },
  },
});

/**
 * Reduce any free-text name to initials (max 3, dot-separated), e.g.
 * "John Smith" -> "J.S.". Already-initialised input ("J.S.", "JS") is
 * preserved. Mirrors public.to_initials() in the database.
 */
function toInitials(v: string): string {
  const raw = v.trim();
  // Already compact and word-free: treat as initials as-is.
  if (raw.length <= 10 && !/[A-Za-z]{4,}/.test(raw)) return raw;
  const letters = raw
    .replace(/[^A-Za-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase());
  return letters.length ? `${letters.join(".")}.` : "X";
}
