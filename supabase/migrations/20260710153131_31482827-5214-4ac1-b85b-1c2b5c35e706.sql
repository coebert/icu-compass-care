-- ============ ENUMS ============
DO $$ BEGIN CREATE TYPE public.referral_status AS ENUM ('pending','declined','admitted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.patient_sex AS ENUM ('male','female','other','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.audit_action AS ENUM ('view','create','update','delete'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.admission_urgency AS ENUM ('within_15_min','within_30_min','within_1_hour','within_1_2_hours'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.ceiling_of_care AS ENUM ('full_escalation','no_cpr','ward_based','symptom_control','not_documented'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.referral_reason_category AS ENUM ('respiratory_failure','sepsis','shock','post_op','neurology','trauma','gi_bleed','metabolic','overdose','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.infection_status AS ENUM ('none','suspected','confirmed','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.resus_status AS ENUM ('for_cpr','dnacpr','not_documented'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.referral_outcome AS ENUM ('admit_for_admission','review_on_ward','advice_given','declined'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.postop_level AS ENUM ('level_1','level_2','level_3'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.postop_booking_status AS ENUM ('requested','provisionally_confirmed','confirmed','admitted','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.postop_cancellation_reason AS ENUM ('no_bed','patient_unfit','surgery_deferred','died_pre_op','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ CLINICAL ACCESS HELPER ============
CREATE OR REPLACE FUNCTION public.has_clinical_access(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'admin') OR public.has_role(_user_id, 'clinician')
$$;

-- ============ PROFILES (augment existing) ============
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS is_at_work BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_capacity BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_capacity_l1 BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_capacity_l2 BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_capacity_l3 BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_new_referral BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_notes BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_status BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_updated_referral BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS shift_updated_at TIMESTAMPTZ;

-- ============ REFERRALS ============
CREATE TABLE public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  accepting_consultant TEXT,
  admission_urgency public.admission_urgency,
  age INT,
  allergies TEXT,
  anticipated_interventions TEXT[] NOT NULL DEFAULT '{}',
  arrived_on_unit_at TIMESTAMPTZ,
  baseline_function_enc TEXT,
  ceiling_of_care public.ceiling_of_care,
  consultant_to_consultant_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  current_bed TEXT,
  current_ward TEXT,
  decision_at TIMESTAMPTZ,
  decline_reason TEXT,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,
  discussed_with_consultant TEXT,
  dnacpr_respect BOOLEAN NOT NULL DEFAULT false,
  first_seen_at TIMESTAMPTZ,
  for_ongoing_ccot_review BOOLEAN NOT NULL DEFAULT false,
  frailty_score INT,
  hospital_number_enc TEXT,
  hospital_number_hash TEXT,
  infection_organism TEXT,
  infection_status public.infection_status,
  is_test BOOLEAN NOT NULL DEFAULT false,
  needs_ward_review BOOLEAN NOT NULL DEFAULT false,
  news2_recorded_at TIMESTAMPTZ,
  news2_score INT,
  origin_booking_id UUID,
  outcome public.referral_outcome,
  outcome_recorded_at TIMESTAMPTZ,
  past_medical_history_enc TEXT,
  previous_referral_id UUID REFERENCES public.referrals(id) ON DELETE SET NULL,
  reason_category public.referral_reason_category,
  reason_for_referral_enc TEXT,
  referral_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referring_specialty TEXT,
  resus_status public.resus_status,
  sex public.patient_sex,
  status public.referral_status NOT NULL DEFAULT 'pending',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  ward_review_timeframe TEXT,
  weight_kg NUMERIC
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Referrals readable by authenticated" ON public.referrals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Referrals insertable by authenticated" ON public.referrals FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Referrals updatable by authenticated" ON public.referrals FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Referrals deletable by admins" ON public.referrals FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER referrals_set_updated_at BEFORE UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX referrals_status_idx ON public.referrals(status);
CREATE INDEX referrals_received_idx ON public.referrals(referral_received_at DESC);

-- ============ POSTOP BOOKINGS ============
CREATE TABLE public.postop_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_number_enc TEXT,
  hospital_number_hash TEXT,
  age INT CHECK (age IS NULL OR (age >= 0 AND age <= 130)),
  sex TEXT CHECK (sex IS NULL OR sex IN ('male','female','other','unknown')),
  weight_kg NUMERIC(6,2) CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 500)),
  height_cm NUMERIC(6,2) CHECK (height_cm IS NULL OR (height_cm > 0 AND height_cm < 300)),
  bmi NUMERIC(5,2) CHECK (bmi IS NULL OR (bmi > 0 AND bmi < 200)),
  proposed_procedure_enc TEXT,
  past_medical_history_enc TEXT,
  past_surgical_history_enc TEXT,
  social_history_enc TEXT,
  reason_for_bed_enc TEXT,
  predicted_level public.postop_level NOT NULL,
  proposed_surgery_date DATE,
  surgical_specialty TEXT,
  arrived_at TIMESTAMPTZ,
  is_test BOOLEAN NOT NULL DEFAULT false,
  booking_status public.postop_booking_status NOT NULL DEFAULT 'requested',
  cancellation_reason public.postop_cancellation_reason,
  cancellation_notes TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  preop_signed_off_at TIMESTAMPTZ,
  preop_signed_off_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  intensivist_reviewed_at TIMESTAMPTZ,
  intensivist_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  converted_referral_id UUID REFERENCES public.referrals(id) ON DELETE SET NULL,
  created_by UUID NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.postop_bookings TO authenticated;
GRANT ALL ON public.postop_bookings TO service_role;
ALTER TABLE public.postop_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Clinicians can view post-op bookings" ON public.postop_bookings FOR SELECT TO authenticated USING (deleted_at IS NULL AND public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinicians can create post-op bookings" ON public.postop_bookings FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()) AND created_by = auth.uid());
CREATE POLICY "Clinicians can update post-op bookings" ON public.postop_bookings FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid())) WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Admins can delete post-op bookings" ON public.postop_bookings FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX postop_bookings_created_at_idx ON public.postop_bookings (created_at DESC);
CREATE INDEX postop_bookings_hospital_hash_idx ON public.postop_bookings (hospital_number_hash);

CREATE OR REPLACE FUNCTION public.postop_bookings_validate_lifecycle()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF NEW.booking_status = 'cancelled' THEN
    IF NEW.cancellation_reason IS NULL THEN
      RAISE EXCEPTION 'cancellation_reason is required when booking_status = cancelled' USING ERRCODE = '22023';
    END IF;
    IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
  END IF;
  IF NEW.booking_status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.booking_status IS DISTINCT FROM 'confirmed') THEN
    IF NEW.preop_signed_off_at IS NULL OR NEW.intensivist_reviewed_at IS NULL THEN
      RAISE EXCEPTION 'Both anaesthetic sign-off and intensivist review are required to confirm a booking' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.booking_status = 'admitted' AND NEW.arrived_at IS NULL THEN NEW.arrived_at := now(); END IF;
  IF NEW.booking_status <> 'cancelled' THEN
    NEW.cancellation_reason := NULL; NEW.cancelled_at := NULL; NEW.cancelled_by := NULL; NEW.cancellation_notes := NULL;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER postop_bookings_validate_lifecycle_trg BEFORE INSERT OR UPDATE ON public.postop_bookings FOR EACH ROW EXECUTE FUNCTION public.postop_bookings_validate_lifecycle();
CREATE TRIGGER postop_bookings_set_updated_at BEFORE UPDATE ON public.postop_bookings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Cyclic FK: referrals -> postop_bookings (added after both tables exist)
ALTER TABLE public.referrals ADD CONSTRAINT referrals_origin_booking_id_fkey FOREIGN KEY (origin_booking_id) REFERENCES public.postop_bookings(id) ON DELETE SET NULL;
CREATE INDEX referrals_origin_booking_idx ON public.referrals (origin_booking_id) WHERE origin_booking_id IS NOT NULL;

-- ============ AUDIT LOG ============
CREATE TABLE public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  action public.audit_action NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  diff JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Audit insertable by authenticated" ON public.audit_log FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Audit readable by admins" ON public.audit_log FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX audit_entity_idx ON public.audit_log(entity, entity_id, created_at DESC);

-- ============ NOTIFICATIONS ============
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referral_id UUID REFERENCES public.referrals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Notifications readable by owner" ON public.notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Notifications insertable by authenticated" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Notifications updatable by owner" ON public.notifications FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX notifications_user_idx ON public.notifications(user_id, created_at DESC);

-- ============ NOTIFICATION DELIVERIES ============
CREATE TABLE public.notification_deliveries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  notification_id UUID NULL REFERENCES public.notifications(id) ON DELETE SET NULL,
  recipient_id UUID NOT NULL,
  actor_id UUID NULL,
  referral_id UUID NULL,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('inapp','push')),
  status TEXT NOT NULL CHECK (status IN ('generated','sent','failed','gone')),
  endpoint TEXT NULL,
  error TEXT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ NULL
);
GRANT SELECT ON public.notification_deliveries TO authenticated;
GRANT ALL ON public.notification_deliveries TO service_role;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Recipients read own delivery records" ON public.notification_deliveries FOR SELECT TO authenticated USING (recipient_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE INDEX idx_notification_deliveries_recipient ON public.notification_deliveries(recipient_id, generated_at DESC);
CREATE INDEX idx_notification_deliveries_referral ON public.notification_deliveries(referral_id);

-- ============ ICNARC TARGETS ============
CREATE TABLE public.icnarc_targets (
  id boolean PRIMARY KEY DEFAULT true,
  time_to_seen_target_min integer NOT NULL DEFAULT 30 CHECK (time_to_seen_target_min > 0 AND time_to_seen_target_min <= 100000),
  decision_to_arrival_target_min integer NOT NULL DEFAULT 240 CHECK (decision_to_arrival_target_min > 0 AND decision_to_arrival_target_min <= 100000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT icnarc_targets_singleton CHECK (id = true)
);
GRANT SELECT, UPDATE ON public.icnarc_targets TO authenticated;
GRANT ALL ON public.icnarc_targets TO service_role;
ALTER TABLE public.icnarc_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Clinicians can read ICNARC targets" ON public.icnarc_targets FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Admins can update ICNARC targets" ON public.icnarc_targets FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER icnarc_targets_set_updated_at BEFORE UPDATE ON public.icnarc_targets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
INSERT INTO public.icnarc_targets (id) VALUES (true);