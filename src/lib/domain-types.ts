import type { Tables } from "@/integrations/supabase/types";

/**
 * Convenience row-type aliases derived from the generated Supabase schema.
 * Prefer these over `Record<string, any>` so field access is type-checked
 * against the actual database columns.
 */
export type Patient = Tables<"patients">;
export type Investigation = Tables<"investigations">;
export type Microbiology = Tables<"microbiology_results">;
export type PatientTask = Tables<"patient_tasks">;
export type PatientEvent = Tables<"patient_events">;
export type PatientReview = Tables<"patient_reviews">;
export type AuditRow = Tables<"audit_log">;
export type IcuBed = Tables<"icu_beds">;
export type Referral = Tables<"referrals">;
export type Profile = Tables<"profiles">;
