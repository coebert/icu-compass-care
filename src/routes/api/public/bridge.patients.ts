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
import { readBodyLimited } from "@/lib/request-body.server";
import { BRIDGE_INPUT_BOUNDS, BRIDGE_MAX_BODY_BYTES, findBoundsViolation } from "@/lib/input-bounds";
import { bridgeUpdateSharedPatient, stripSharingFlags } from "@/lib/bridge-sharing.server";
import { bedTakenInUnit, isBedUniqueViolation, occupiesBed } from "@/lib/bed-occupancy.server";
import { resolveBridgeUnitId } from "@/lib/scope.server";

// The bridge deliberately keeps a LOOSER schema than the app (see patient-schema.ts):
// the partner system is trusted, may send longer names, treats every field as
// optional, and is not subject to the app's status-transition rules. The structured
// fields are spread in from PATIENT_ARRAY_FIELDS so this stays in step with the app
// model whenever new structured fields are added.
const patientFields = z.object({
  // Optimistic concurrency: the updated_at the caller last saw. When present on
  // an update, the write is rejected (409) if the record changed since then.
  expected_updated_at: z.string().max(64).optional(),
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

// Create: no id, a valid name is required.
const patientCreate = patientFields.strict().or(patientFields);
// Update by id: a bounded PARTIAL change (e.g. a bed move or prefill) — any
// subset of fields; a name, if sent, must still be valid. id, unit and
// sharing are never writable (stripped again in bridgeUpdateSharedPatient).
const patientUpdate = patientFields.partial().extend({ id: z.string().uuid() });
const statusParam = z.enum(["referred", "admitted", "discharged", "died"]);

function stripGovernance(p: Record<string, unknown>) {
  const { shared_with_partner, shared_with_partner_at, shared_with_partner_by, ...rest } = p;
  void shared_with_partner;
  void shared_with_partner_at;
  void shared_with_partner_by;
  return rest;
}
const bedOccupied = () =>
  json({ error: "bed_occupied", message: "That bed is already occupied in this unit." }, 409);


export const Route = createFileRoute("/api/public/bridge/patients")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      // List shared patients in the bridge unit (optionally ?status=admitted),
      // or fetch ONE by ?id=<uuid> in the same {patients:[...]} envelope.
      // Not shared, another unit, revoked or nonexistent: identical empty list.
      GET: async ({ request }) => {
        const auth = await authorizeBridge(request, "", { write: false }, "/bridge/patients");
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        const rawId = url.searchParams.get("id");
        const rawStatus = url.searchParams.get("status");
        const id = rawId === null ? null : z.string().uuid().safeParse(rawId);
        const status = rawStatus === null ? null : statusParam.safeParse(rawStatus);
        if ((id && !id.success) || (status && !status.success)) {
          return json({ error: "Invalid query" }, 400);
        }

        const supabaseAdmin = await getAdmin();
        let unitId: string;
        try {
          unitId = await resolveBridgeUnitId(supabaseAdmin);
        } catch {
          return json({ error: "Service unavailable" }, 503);
        }
        let query = supabaseAdmin
          .from("patients")
          .select("*")
          // Governance gate: only the bridge unit, only patients an
          // administrator explicitly marked as shared.
          .eq("unit_id", unitId)
          .eq("shared_with_partner", true)
          .order("updated_at", { ascending: false });
        if (id?.success) query = query.eq("id", id.data);
        if (status?.success) query = query.eq("status", status.data);

        const { data, error } = await query;
        if (error) return (console.error("[bridge] patients read failed"), json({ error: "Internal server error" }, 500));
        // The sharing flag is a local governance decision, not clinical data —
        // never leak it to the partner (and never let it overwrite their copy).
        const patients = decryptPatientRows(data as Array<Record<string, unknown>> | null).map(
          (p: Record<string, unknown>) => stripGovernance(p),
        );
        await logSync(supabaseAdmin, { direction: "pull", entity: "patients", record_count: patients.length, actor: auth.actor });
        return json({ patients });
      },


      // Create or update a patient (upsert by id when provided)
      POST: async ({ request }) => {
        // Size cap before the body is buffered, signed or parsed.
        const body = await readBodyLimited(request, BRIDGE_MAX_BODY_BYTES);
        if (!body.ok) return json({ error: "Payload too large" }, 413);
        const rawBody = body.text;
        const auth = await authorizeBridge(request, rawBody, { write: true, roles: ["admin", "unit_admin", "clinician"] }, "/bridge/patients");
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
          const raw: unknown = JSON.parse(rawBody || "{}");
          // Oversized lists are refused before Zod 3 can expand them (GHSA-mrhx-c7xc-m3w5).
          if (findBoundsViolation(raw, BRIDGE_INPUT_BOUNDS)) {
            return json({ error: "Invalid patient payload" }, 400);
          }
          const hasId =
            !!raw && typeof raw === "object" && !Array.isArray(raw) && "id" in (raw as object);
          parsed = hasId
            ? { mode: "update" as const, value: patientUpdate.parse(raw) }
            : { mode: "create" as const, value: patientCreate.parse(raw) };
        } catch {
          return json({ error: "Invalid patient payload" }, 400);
        }

        const supabaseAdmin = await getAdmin();
        let unitId: string;
        try {
          unitId = await resolveBridgeUnitId(supabaseAdmin);
        } catch {
          return json({ error: "Service unavailable" }, 503);
        }
        // Strip control fields that are not table columns.
        const { expected_updated_at, ...columns } = parsed.value as Record<string, unknown> & {
          expected_updated_at?: string;
        };
        const record = clean(columns);

        if (parsed.mode === "update") {
          const { id: targetId, ...changes } = record as Record<string, unknown> & { id: string };
          if (Object.keys(changes).length === 0) {
            return json({ error: "Invalid patient payload" }, 400);
          }
          const outcome = await bridgeUpdateSharedPatient(supabaseAdmin, {
            id: targetId,
            unitId,
            expectedUpdatedAt: expected_updated_at,
            payload: encryptPatientPayload(changes) as Record<string, unknown>,
          });
          if (outcome.kind === "bed_conflict") return bedOccupied();
          if (outcome.kind === "error") {
            return (console.error("[bridge] patient update failed"), json({ error: "Internal server error" }, 500));
          }
          // Not shared (or sharing revoked, or nonexistent): identical answer,
          // no clinical data, no hint the record exists.
          if (outcome.kind === "not_found") return json({ error: "Patient not found" }, 404);
          if (outcome.kind === "conflict") {
            return json(
              {
                error: "conflict",
                message: "This patient was modified since you last loaded it.",
                current: stripSharingFlags(decryptPatientRow(outcome.current)),
                your_expected_updated_at: expected_updated_at,
              },
              409,
            );
          }
          const { before: current, after: data } = outcome;

          await writeAudit(supabaseAdmin, {
            entity: "patients",
            recordId: data["id"] as string,
            action: "update",
            source: "bridge",
            actor: auth.actor,
            before: current,
            after: data,
            // Ciphertext can't be diffed byte-wise; compare readable values.
            changedFields: diffFields(decryptPatientRow(current), decryptPatientRow(data)),
          });
          await logSync(supabaseAdmin, { direction: "push", entity: "patients", record_count: 1, actor: auth.actor });
          return json({ patient: stripSharingFlags(decryptPatientRow(data)) });
        }

        // Partner creates always land in the bridge unit; the payload can't
        // choose another one (unit_id isn't an accepted field).
        try {
          if (occupiesBed({ location_type: "icu", status: "admitted", ...record }) &&
              (await bedTakenInUnit(supabaseAdmin, unitId, record.bed as string, null))) {
            return bedOccupied();
          }
        } catch {
          return json({ error: "Internal server error" }, 500);
        }
        const { data, error } = await supabaseAdmin
          .from("patients")
          .insert(encryptPatientPayload({ ...record, unit_id: unitId }) as never)
          .select()
          .maybeSingle();

        if (error) {
          if (isBedUniqueViolation(error)) return bedOccupied();
          return (console.error("[bridge] patient create failed"), json({ error: "Internal server error" }, 500));
        }
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
        return json({ patient: stripSharingFlags(decryptPatientRow(data as Record<string, unknown>)) });
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
