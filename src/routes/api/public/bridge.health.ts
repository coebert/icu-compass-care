import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, json } from "@/lib/api-bridge.server";
import { getAdmin } from "@/lib/admin-db.server";

// The exact column list GET /api/public/bridge/patients serializes via
// `select("*")`, kept in sync with the patients table. Used as a fallback
// when the table is empty and no live row is available to introspect.
const PATIENT_FIELD_KEYS = [
  "id",
  "created_by",
  "updated_by",
  "full_name",
  "hospital_number",
  "age",
  "location_type",
  "ward",
  "bed",
  "status",
  "admission_date",
  "discharge_date",
  "discharge_destination",
  "date_of_death",
  "past_medical_history",
  "current_admission",
  "current_management",
  "outstanding_tasks",
  "systems_resp",
  "resp_fio2",
  "systems_cvs",
  "systems_neuro",
  "systems_renal",
  "systems_gastro",
  "systems_haem",
  "systems_micro",
  "systems_other",
  "tep_in_place",
  "tep_details",
  "dnacpr_decision",
  "dnacpr_details",
  "dnacpr_date",
  "nok_name",
  "nok_relationship",
  "nok_contact",
  "nok_last_updated",
  "nok_last_updated_by",
  "created_at",
  "updated_at",
] as const;

export const Route = createFileRoute("/api/public/bridge/health")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      // Unauthenticated health/config check. Reports only whether the shared
      // secret is configured (never its value) and the exact serialized field
      // keys the patients bridge returns, so the linked project can verify
      // compatibility. No patient data is returned.
      GET: async () => {
        const secretConfigured = Boolean(process.env.HANDOVER_API_SECRET);

        // Introspect a live row so the reported keys are exactly what GET
        // /api/public/bridge/patients serializes. Fall back to the static
        // list when the table is empty.
        let patientFieldKeys: string[] = [...PATIENT_FIELD_KEYS];
        try {
          const supabaseAdmin = await getAdmin();
          const { data, error } = await supabaseAdmin
            .from("patients")
            .select("*")
            .limit(1)
            .maybeSingle();
          if (!error && data) patientFieldKeys = Object.keys(data);
        } catch (e) {
          console.error("[bridge/health]", e);
        }

        return json({
          ok: true,
          service: "bridge",
          handover_api_secret_configured: secretConfigured,
          partner_bridge_url_configured: Boolean(process.env.PARTNER_BRIDGE_URL),
          patient_field_keys: patientFieldKeys,
          patient_field_count: patientFieldKeys.length,
          timestamp: new Date().toISOString(),
        });
      },
    },
  },
});
