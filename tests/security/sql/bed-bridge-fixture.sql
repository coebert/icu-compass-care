-- Synthetic stand-in for the live columns, enums and triggers the staged
-- bed-integrity / bridge-import migration builds on. Column lists, enum
-- labels and trigger bodies were read from the live schema (metadata only).
-- Applied AFTER fixture.sql and the security-remediation migrations. No data.
CREATE TYPE public.patient_location AS ENUM ('icu', 'outlier');
CREATE TYPE public.patient_status AS ENUM ('referred', 'admitted', 'discharged', 'died');
CREATE TYPE public.patient_sex AS ENUM ('male', 'female', 'other', 'unknown');
CREATE TYPE public.referral_status AS ENUM ('pending', 'declined', 'admitted');
CREATE TYPE public.referral_reason_category AS ENUM ('respiratory_failure', 'sepsis', 'shock', 'post_op', 'neurology', 'trauma', 'gi_bleed', 'metabolic', 'overdose', 'other');
CREATE TYPE public.ceiling_of_care AS ENUM ('full_escalation', 'no_cpr', 'ward_based', 'symptom_control', 'not_documented');
CREATE TYPE public.resus_status AS ENUM ('for_cpr', 'dnacpr', 'not_documented');
CREATE TYPE public.admission_urgency AS ENUM ('within_15_min', 'within_30_min', 'within_1_hour', 'within_1_2_hours');
CREATE TYPE public.infection_status AS ENUM ('none', 'suspected', 'confirmed', 'unknown');
CREATE TYPE public.referral_outcome AS ENUM ('admit_for_admission', 'review_on_ward', 'advice_given', 'declined');

ALTER TABLE public.patients
  ADD COLUMN bed text,
  ADD COLUMN status public.patient_status NOT NULL DEFAULT 'admitted',
  ADD COLUMN location_type public.patient_location NOT NULL DEFAULT 'icu',
  ADD COLUMN isolation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_by uuid,
  ADD COLUMN wardable boolean NOT NULL DEFAULT false,
  ADD COLUMN wardable_at timestamptz,
  ADD COLUMN wardable_by uuid,
  ADD COLUMN source_referral_id uuid;

-- Verbatim live trigger function.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;
-- Live has two identical patient updated_at triggers; both reproduced.
CREATE TRIGGER trg_patients_updated_at BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_patients_updated_at BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_investigations_updated_at BEFORE UPDATE ON public.investigations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE public.icu_beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  position integer NOT NULL,
  is_side_room boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.microbiology_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id),
  specimen_type text NOT NULL,
  findings text NOT NULL,
  result_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER update_microbiology_results_updated_at BEFORE UPDATE ON public.microbiology_results FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accepting_consultant text,
  admission_urgency public.admission_urgency,
  age integer,
  allergies text,
  anticipated_interventions text[] NOT NULL DEFAULT '{}'::text[],
  arrived_on_unit_at timestamptz,
  baseline_function_enc text,
  ceiling_of_care public.ceiling_of_care,
  consultant_to_consultant_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  current_bed text,
  current_ward text,
  decision_at timestamptz,
  decline_reason text,
  deleted_at timestamptz,
  deleted_by uuid,
  discussed_with_consultant text,
  dnacpr_respect boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz,
  for_ongoing_ccot_review boolean NOT NULL DEFAULT false,
  frailty_score integer,
  hospital_number_enc text,
  hospital_number_hash text,
  infection_organism text,
  infection_status public.infection_status,
  is_test boolean NOT NULL DEFAULT false,
  needs_ward_review boolean NOT NULL DEFAULT false,
  news2_recorded_at timestamptz,
  news2_score integer,
  origin_booking_id uuid,
  outcome public.referral_outcome,
  outcome_recorded_at timestamptz,
  past_medical_history_enc text,
  previous_referral_id uuid,
  reason_category public.referral_reason_category,
  reason_for_referral_enc text,
  referral_received_at timestamptz NOT NULL DEFAULT now(),
  referring_specialty text,
  resus_status public.resus_status,
  sex public.patient_sex,
  status public.referral_status NOT NULL DEFAULT 'pending',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  ward_review_timeframe text,
  weight_kg numeric
);
CREATE TRIGGER referrals_set_updated_at BEFORE UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Live grants (table privileges; RLS decides rows).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patients, public.referrals, public.investigations,
  public.microbiology_results, public.icu_beds TO authenticated, service_role;

-- Live patient write policy (has_unit_access -> can_edit_unit).
CREATE OR REPLACE FUNCTION private.has_unit_access(_user_id uuid, _unit_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.can_edit_unit(_user_id, _unit_id);
$$;
CREATE POLICY "Clinical staff can update patients in their units" ON public.patients FOR UPDATE TO authenticated
  USING (private.has_unit_access(auth.uid(), unit_id)) WITH CHECK (private.has_unit_access(auth.uid(), unit_id));
CREATE POLICY "Clinical staff can insert patients in their units" ON public.patients FOR INSERT TO authenticated
  WITH CHECK (private.has_unit_access(auth.uid(), unit_id));
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.microbiology_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icu_beds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read beds" ON public.icu_beds FOR SELECT TO authenticated USING (true);

-- Live record_audit / patient_field_changes are written only by server code
-- (service role) and SECURITY DEFINER helpers; mirror "no direct writes".
REVOKE INSERT, UPDATE, DELETE ON public.record_audit FROM anon, authenticated;
