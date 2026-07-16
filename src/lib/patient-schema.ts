import { z } from "zod";
import { zTimestampNullish } from "@/lib/datetime";

// Shared, client-safe patient schema + lifecycle rules.
//
// This is the single source of truth for the primary app's patient validation
// (used by src/lib/patients.functions.ts). The cross-project bridge deliberately
// keeps its OWN, looser schema (bridge.patients.ts): it accepts longer names from
// the partner system, treats every field as optional, and does NOT enforce the
// status-transition rules below — the partner app is a trusted caller. Keep the
// pure helpers (`clean`, `PATIENT_ARRAY_FIELDS`) shared so the two paths cannot
// drift on data-shaping, while the differing validation strictness stays explicit.

// Age — client rules: required, whole number, 0-130. Server messages MUST
// match the strings in `src/components/patient/demographics-tab.tsx`.
export const ageSchema = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : v),
  z
    .union([z.number(), z.string().trim().min(1)], {
      errorMap: (issue, ctx) => {
        if (issue.code === "invalid_type" && ctx.data === undefined) {
          return { message: "Age is required." };
        }
        return { message: "Age must be a whole number." };
      },
    })
    .pipe(
      z.coerce
        .number({ invalid_type_error: "Age must be a whole number." })
        .int("Age must be a whole number.")
        .min(0, "Age must be between 0 and 130.")
        .max(130, "Age must be between 0 and 130."),
    ),
);

// Sex — fixed allow-list, matches the Demographics tab options.
export const SEX_VALUES = ["male", "female", "other", "unknown"] as const;
export const sexSchema = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.enum(SEX_VALUES, {
    errorMap: (issue, ctx) => {
      if (issue.code === "invalid_type" && ctx.data === undefined) {
        return { message: "Sex is required." };
      }
      return {
        message: "Invalid value. Choose one of: Female, Male, Other, Unknown.",
      };
    },
  }),
);

export const patientInput = z.object({
  full_name: z
    .string({ required_error: "Initials / name is required." })
    .trim()
    .min(1, "Initials / name is required.")
    .max(10, "Max 10 characters."),
  hospital_number: z
    .string()
    .trim()
    .max(50, "Max 50 characters.")
    .regex(/^[A-Za-z0-9\-\s]*$/, "Letters, numbers and hyphens only.")
    .optional()
    .nullable(),
  age: ageSchema,
  sex: sexSchema,

  location_type: z.enum(["icu", "outlier"]),
  ward: z.string().trim().max(100).optional().nullable(),
  bed: z.string().trim().max(50).optional().nullable(),
  parent_specialty: z.string().trim().max(100).optional().nullable(),
  specialty_consultant: z.string().trim().max(100).optional().nullable(),
  status: z.enum(["referred", "admitted", "discharged", "died"]),
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
  airway_type: z.string().max(20).optional().nullable(),
  resp_support: z.array(z.string().max(20)).max(10).optional(),
  systems_cvs: z.string().max(10000).optional().nullable(),
  vasoactive_agents: z.array(z.string().max(20)).max(10).optional(),
  systems_neuro: z.string().max(10000).optional().nullable(),
  sedative_agents: z.array(z.string().max(20)).max(20).optional(),
  pca_agents: z.array(z.string().max(20)).max(10).optional(),
  regional_analgesia: z.array(z.string().max(20)).max(10).optional(),
  systems_renal: z.string().max(10000).optional().nullable(),
  renal_diuretics: z.boolean().optional(),
  renal_rrt: z.boolean().optional(),
  systems_gastro: z.string().max(10000).optional().nullable(),
  nutrition_route: z.array(z.string().max(20)).max(10).optional(),
  systems_haem: z.string().max(10000).optional().nullable(),
  anticoagulation: z.array(z.string().max(20)).max(10).optional(),
  systems_micro: z.string().max(10000).optional().nullable(),
  antimicrobials: z
    .array(
      z.object({
        name: z.string().max(100),
        started_on: z.string().max(20),
        ended_on: z.string().max(20).optional().nullable(),
      }),
    )
    .max(30)
    .optional(),
  systems_other: z.string().max(10000).optional().nullable(),
  isolation_required: z.boolean(),
  tep_in_place: z.boolean(),
  tep_details: z.string().max(10000).optional().nullable(),
  tep_exclusions: z.array(z.enum(["hfno", "niv", "ivv", "cvvh", "vasopressors"])).optional(),
  dnacpr_decision: z.boolean(),
  dnacpr_details: z.string().max(10000).optional().nullable(),
  dnacpr_date: z.string().optional().nullable(),
  nok_name: z.string().trim().max(200).optional().nullable(),
  nok_relationship: z.string().trim().max(100).optional().nullable(),
  nok_contact: z.string().trim().max(200).optional().nullable(),
  nok_last_updated: zTimestampNullish,
  nok_last_updated_by: z.string().trim().max(200).optional().nullable(),
  weight_kg: z
    .preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z
        .union([z.number(), z.string().trim().min(1)], {
          errorMap: () => ({ message: "Weight must be a valid number." }),
        })
        .pipe(
          z.coerce
            .number({ invalid_type_error: "Weight must be a valid number." })
            .min(0, "Weight must be between 0 and 600 kg.")
            .max(600, "Weight must be between 0 and 600 kg."),
        )
        .nullable(),
    )
    .optional(),
  height_m: z
    .preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z
        .union([z.number(), z.string().trim().min(1)], {
          errorMap: () => ({ message: "Height must be a valid number." }),
        })
        .pipe(
          z.coerce
            .number({ invalid_type_error: "Height must be a valid number." })
            .min(0, "Height must be between 0 and 3 m.")
            .max(3, "Height must be between 0 and 3 m."),
        )
        .nullable(),
    )
    .optional(),
  allergies: z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v.filter(
            (a) =>
              a && typeof a === "object" && String((a as Record<string, unknown>).substance ?? "").trim() !== "",
          )
        : v,
    z
      .array(
        z.object({
          substance: z.string().trim().min(1).max(200),
          reaction: z.string().trim().max(500).optional().nullable(),
          severity: z
            .enum(["unknown", "mild", "moderate", "severe", "anaphylaxis"])
            .optional()
            .nullable(),
        }),
      )
      .max(50)
      .optional(),
  ),
  daily_goals: z.record(z.string(), z.boolean()).optional(),
  daily_goals_reviewed_at: z.string().optional().nullable(),
  daily_goals_reviewed_by: z.string().trim().max(200).optional().nullable(),
  // "Ready for the ward" marker. The server auto-stamps wardable_at/by on
  // transition; callers only need to send the boolean.
  wardable: z.boolean().optional(),
  wardable_at: zTimestampNullish.optional(),
  wardable_by: z.string().trim().max(200).optional().nullable(),
});

// Structured (array/boolean) patient fields. The bridge schema uses this list so
// it stays representable when new structured fields are added to the app model.
export const PATIENT_ARRAY_FIELDS = {
  resp_support: z.array(z.string().max(20)).max(10).optional(),
  vasoactive_agents: z.array(z.string().max(20)).max(10).optional(),
  sedative_agents: z.array(z.string().max(20)).max(20).optional(),
  pca_agents: z.array(z.string().max(20)).max(10).optional(),
  regional_analgesia: z.array(z.string().max(20)).max(10).optional(),
  nutrition_route: z.array(z.string().max(20)).max(10).optional(),
  anticoagulation: z.array(z.string().max(20)).max(10).optional(),
  airway_type: z.string().max(20).optional().nullable(),
  renal_diuretics: z.boolean().optional(),
  renal_rrt: z.boolean().optional(),
  isolation_required: z.boolean().optional(),
  antimicrobials: z
    .array(
      z.object({
        name: z.string().max(100),
        started_on: z.string().max(20),
        ended_on: z.string().max(20).optional().nullable(),
      }),
    )
    .max(30)
    .optional(),
} as const;

// Normalise empty strings to null for date/optional fields.
export function clean<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === "" ? null : v;
  return out as T;
}

export type PatientStatus = "referred" | "admitted" | "discharged" | "died";

// Allowed forward transitions between clinical statuses. Staying on the same
// status is always allowed (it lets staff edit other fields without changing
// the lifecycle). "discharged" and "died" are terminal — records are retained
// and stay editable, but the status cannot move to a different value.
export const ALLOWED_TRANSITIONS: Record<PatientStatus, PatientStatus[]> = {
  referred: ["admitted", "discharged", "died"],
  admitted: ["discharged", "died"],
  discharged: [],
  died: [],
};

export const STATUS_LABEL: Record<PatientStatus, string> = {
  referred: "Referred",
  admitted: "Admitted",
  discharged: "Discharged",
  died: "Died",
};

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

// Server-side guard for status lifecycle + per-status required fields.
// `merged` is the full effective row after the write (current row overlaid with
// the incoming changes for updates, or the incoming payload for creates).
// `previousStatus` is the status before this write (undefined on create).
export function validatePatientState(
  merged: Record<string, unknown>,
  previousStatus?: PatientStatus,
) {
  const next = merged.status as PatientStatus | undefined;
  if (!next || !(next in ALLOWED_TRANSITIONS)) {
    throw new Error("A valid patient status is required.");
  }

  // Transition legality (only checked when the status actually changes).
  if (previousStatus && previousStatus !== next) {
    const allowed = ALLOWED_TRANSITIONS[previousStatus] ?? [];
    if (!allowed.includes(next)) {
      const options =
        allowed.length > 0
          ? allowed.map((s) => STATUS_LABEL[s]).join(" or ")
          : "no further status changes";
      throw new Error(
        `Invalid status change: a ${STATUS_LABEL[previousStatus]} patient cannot become ${STATUS_LABEL[next]} (allowed: ${options}).`,
      );
    }
  }

  // Per-status required fields.
  if (next === "discharged") {
    if (isBlank(merged.discharge_destination)) {
      throw new Error("A discharge destination is required to mark a patient as discharged.");
    }
    if (isBlank(merged.discharge_date)) {
      throw new Error("A discharge date is required to mark a patient as discharged.");
    }
  }
  if (next === "died") {
    if (isBlank(merged.date_of_death)) {
      throw new Error("A date of death is required to mark a patient as died.");
    }
  }

  // Note: field-level demographics rules (initials/name, age, sex, hospital
  // number, weight) are enforced by `patientInput` (create) and by its
  // `.partial()` in `updatePatient` (which still validates the shape of any
  // field explicitly present in the patch). We deliberately do NOT require
  // these fields on the *merged* row here — existing rows may pre-date the
  // rule and unrelated field edits must not fail because sex is still null.
}
