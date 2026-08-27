-- ===========================================================================
-- 1. Role helper functions (private schema, security definer)
-- ===========================================================================

-- Membership of a specific ICU unit (explicit grant only).
CREATE OR REPLACE FUNCTION private.is_unit_member(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT _user_id IS NOT NULL AND _unit_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_unit_access ua
    WHERE ua.user_id = _user_id AND ua.unit_id = _unit_id
  );
$$;

-- Roles allowed to RECORD clinical information.
CREATE OR REPLACE FUNCTION private.has_clinical_access(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.has_role(_user_id, 'clinician')
      OR private.has_role(_user_id, 'unit_admin');
$$;

-- Trust / system administrator ('admin' retained as the legacy spelling).
CREATE OR REPLACE FUNCTION private.is_trust_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.has_role(_user_id, 'trust_admin')
      OR private.has_role(_user_id, 'admin');
$$;

CREATE OR REPLACE FUNCTION private.is_auditor(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.has_role(_user_id, 'auditor');
$$;

-- May change configuration somewhere (scope still checked per unit).
CREATE OR REPLACE FUNCTION private.is_config_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.has_role(_user_id, 'unit_admin') OR private.is_trust_admin(_user_id);
$$;

-- Clinical WRITE scope: member of the unit, in a recording role.
CREATE OR REPLACE FUNCTION private.can_edit_unit(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.has_clinical_access(_user_id)
     AND private.is_unit_member(_user_id, _unit_id);
$$;

-- Clinical READ scope: write scope, plus Trust administrator break-glass view.
CREATE OR REPLACE FUNCTION private.can_view_unit(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.can_edit_unit(_user_id, _unit_id)
      OR private.is_trust_admin(_user_id);
$$;

-- Configuration scope for a unit: own units for a unit admin, all for Trust.
CREATE OR REPLACE FUNCTION private.can_admin_unit(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.is_trust_admin(_user_id)
      OR (private.has_role(_user_id, 'unit_admin')
          AND private.is_unit_member(_user_id, _unit_id));
$$;

CREATE OR REPLACE FUNCTION private.can_edit_patient(_user_id uuid, _patient_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = _patient_id AND private.can_edit_unit(_user_id, p.unit_id)
  );
$$;

CREATE OR REPLACE FUNCTION private.can_view_patient(_user_id uuid, _patient_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = _patient_id AND private.can_view_unit(_user_id, p.unit_id)
  );
$$;

-- Does the actor administer at least one unit the target account belongs to?
CREATE OR REPLACE FUNCTION private.shares_admin_unit(_actor uuid, _target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT _actor IS NOT NULL AND _target IS NOT NULL
     AND private.has_role(_actor, 'unit_admin')
     AND EXISTS (
       SELECT 1
       FROM public.user_unit_access a
       JOIN public.user_unit_access t ON t.unit_id = a.unit_id
       WHERE a.user_id = _actor AND t.user_id = _target
     );
$$;

-- Legacy names kept so existing policies stay meaningful: both are WRITE scope.
CREATE OR REPLACE FUNCTION private.has_unit_access(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.can_edit_unit(_user_id, _unit_id);
$$;

CREATE OR REPLACE FUNCTION private.can_access_patient(_user_id uuid, _patient_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.can_edit_patient(_user_id, _patient_id);
$$;

-- ===========================================================================
-- 2. Grandfather existing administrators so nobody loses access
-- ===========================================================================

INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT ur.user_id, 'trust_admin'::app_role
FROM public.user_roles ur WHERE ur.role = 'admin'
ON CONFLICT (user_id, role) DO NOTHING;

INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT ur.user_id, 'unit_admin'::app_role
FROM public.user_roles ur WHERE ur.role = 'admin'
ON CONFLICT (user_id, role) DO NOTHING;

-- Previous 'admin' meant implicit access to every unit; make that explicit.
INSERT INTO public.user_unit_access (user_id, unit_id, reason)
SELECT DISTINCT ur.user_id, u.id, 'migrated from global admin role'
FROM public.user_roles ur CROSS JOIN public.icu_units u
WHERE ur.role = 'admin'
ON CONFLICT (user_id, unit_id) DO NOTHING;

DELETE FROM public.user_roles WHERE role = 'admin';

-- ===========================================================================
-- 3. Patient record and every patient-scoped clinical table
--    read  = can_view_patient (adds Trust break-glass view)
--    write = can_edit_patient (unit membership + recording role)
-- ===========================================================================

DROP POLICY IF EXISTS "Clinical staff can view patients in their units" ON public.patients;
CREATE POLICY "Scoped staff and Trust admins can view patients"
  ON public.patients FOR SELECT TO authenticated
  USING (private.can_view_unit(auth.uid(), unit_id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'chart_days','handover_acknowledgements','investigations','microbiology_results',
    'patient_events','patient_field_changes','patient_lines','patient_observations',
    'patient_reviews','patient_tasks'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Scoped staff can view ' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (private.can_view_patient(auth.uid(), patient_id))',
      'Scoped staff and Trust admins can view ' || t, t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Scoped staff can view chart_hourly" ON public.chart_hourly;
CREATE POLICY "Scoped staff and Trust admins can view chart_hourly"
  ON public.chart_hourly FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.chart_days d
    WHERE d.id = chart_hourly.chart_day_id
      AND private.can_view_patient(auth.uid(), d.patient_id)
  ));

-- Edit history and attribution: viewable by auditors too (metadata only).
DROP POLICY IF EXISTS "Scoped staff and Trust admins can view patient_field_changes" ON public.patient_field_changes;
CREATE POLICY "Scoped staff, Trust admins and auditors can view edit history"
  ON public.patient_field_changes FOR SELECT TO authenticated
  USING (private.can_view_patient(auth.uid(), patient_id) OR private.is_auditor(auth.uid()));

-- Partner sharing switches: unit administrators for their own unit, Trust anywhere.
CREATE OR REPLACE FUNCTION public.patients_guard_share_flag()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.shared_with_partner IS DISTINCT FROM OLD.shared_with_partner THEN
    IF auth.uid() IS NULL OR NOT private.can_admin_unit(auth.uid(), NEW.unit_id) THEN
      RAISE EXCEPTION 'Only administrators of this unit can change patient sharing'
        USING ERRCODE = '42501';
    END IF;
    NEW.shared_with_partner_at := now();
    NEW.shared_with_partner_by := auth.uid();
  END IF;
  RETURN NEW;
END $function$;

-- ===========================================================================
-- 4. Unit-independent clinical tables: recording roles write, Trust views
-- ===========================================================================

DROP POLICY IF EXISTS "Referrals readable by clinical staff" ON public.referrals;
CREATE POLICY "Referrals readable by clinical staff and Trust admins"
  ON public.referrals FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid()) OR private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Referrals deletable by admins" ON public.referrals;
CREATE POLICY "Referrals deletable by Trust admins"
  ON public.referrals FOR DELETE TO authenticated
  USING (private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Clinicians can view post-op bookings" ON public.postop_bookings;
CREATE POLICY "Clinical staff and Trust admins can view post-op bookings"
  ON public.postop_bookings FOR SELECT TO authenticated
  USING (deleted_at IS NULL
         AND (private.has_clinical_access(auth.uid()) OR private.is_trust_admin(auth.uid())));

DROP POLICY IF EXISTS "Admins can delete post-op bookings" ON public.postop_bookings;
CREATE POLICY "Trust admins can delete post-op bookings"
  ON public.postop_bookings FOR DELETE TO authenticated
  USING (private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Clinical staff can read handover versions" ON public.handover_versions;
CREATE POLICY "Clinical staff and Trust admins can read handover versions"
  ON public.handover_versions FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid()) OR private.is_trust_admin(auth.uid()));

-- ===========================================================================
-- 5. Unit and hospital configuration
-- ===========================================================================

DROP POLICY IF EXISTS "Clinical staff can view hospitals" ON public.hospitals;
CREATE POLICY "Staff with a role can view hospitals"
  ON public.hospitals FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid())
         OR private.is_config_admin(auth.uid())
         OR private.is_auditor(auth.uid()));

DROP POLICY IF EXISTS "Admins can insert hospitals" ON public.hospitals;
DROP POLICY IF EXISTS "Admins can update hospitals" ON public.hospitals;
DROP POLICY IF EXISTS "Admins can delete hospitals" ON public.hospitals;
CREATE POLICY "Trust admins can insert hospitals" ON public.hospitals
  FOR INSERT TO authenticated WITH CHECK (private.is_trust_admin(auth.uid()));
CREATE POLICY "Trust admins can update hospitals" ON public.hospitals
  FOR UPDATE TO authenticated USING (private.is_trust_admin(auth.uid()))
  WITH CHECK (private.is_trust_admin(auth.uid()));
CREATE POLICY "Trust admins can delete hospitals" ON public.hospitals
  FOR DELETE TO authenticated USING (private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Clinical staff can view icu_units" ON public.icu_units;
CREATE POLICY "Staff with a role can view icu_units"
  ON public.icu_units FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid())
         OR private.is_config_admin(auth.uid())
         OR private.is_auditor(auth.uid()));

DROP POLICY IF EXISTS "Admins can insert icu_units" ON public.icu_units;
DROP POLICY IF EXISTS "Admins can update icu_units" ON public.icu_units;
DROP POLICY IF EXISTS "Admins can delete icu_units" ON public.icu_units;
CREATE POLICY "Trust admins can insert icu_units" ON public.icu_units
  FOR INSERT TO authenticated WITH CHECK (private.is_trust_admin(auth.uid()));
CREATE POLICY "Unit or Trust admins can update their icu_units" ON public.icu_units
  FOR UPDATE TO authenticated USING (private.can_admin_unit(auth.uid(), id))
  WITH CHECK (private.can_admin_unit(auth.uid(), id));
CREATE POLICY "Trust admins can delete icu_units" ON public.icu_units
  FOR DELETE TO authenticated USING (private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can insert beds" ON public.icu_beds;
DROP POLICY IF EXISTS "Admins can update beds" ON public.icu_beds;
DROP POLICY IF EXISTS "Admins can delete beds" ON public.icu_beds;
CREATE POLICY "Config admins can insert beds" ON public.icu_beds
  FOR INSERT TO authenticated WITH CHECK (private.is_config_admin(auth.uid()));
CREATE POLICY "Config admins can update beds" ON public.icu_beds
  FOR UPDATE TO authenticated USING (private.is_config_admin(auth.uid()))
  WITH CHECK (private.is_config_admin(auth.uid()));
CREATE POLICY "Config admins can delete beds" ON public.icu_beds
  FOR DELETE TO authenticated USING (private.is_config_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can update ICNARC targets" ON public.icnarc_targets;
CREATE POLICY "Config admins can update ICNARC targets" ON public.icnarc_targets
  FOR UPDATE TO authenticated USING (private.is_config_admin(auth.uid()))
  WITH CHECK (private.is_config_admin(auth.uid()));

-- ===========================================================================
-- 6. Accounts, roles and unit membership
-- ===========================================================================

DROP POLICY IF EXISTS "Admins can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;
CREATE POLICY "Administrators and auditors can view roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid())
         OR private.is_auditor(auth.uid())
         OR private.shares_admin_unit(auth.uid(), user_id));
CREATE POLICY "Trust admins can grant any role" ON public.user_roles
  FOR INSERT TO authenticated WITH CHECK (private.is_trust_admin(auth.uid()));
CREATE POLICY "Trust admins can revoke any role" ON public.user_roles
  FOR DELETE TO authenticated USING (private.is_trust_admin(auth.uid()));
-- A unit administrator may only hand out non-privileged roles, and only to
-- accounts that already belong to a unit they administer.
CREATE POLICY "Unit admins can grant unit roles" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (role IN ('clinician', 'unit_admin')
              AND private.shares_admin_unit(auth.uid(), user_id));
CREATE POLICY "Unit admins can revoke unit roles" ON public.user_roles
  FOR DELETE TO authenticated
  USING (role IN ('clinician', 'unit_admin')
         AND private.shares_admin_unit(auth.uid(), user_id));

DROP POLICY IF EXISTS "Users can view own unit access" ON public.user_unit_access;
DROP POLICY IF EXISTS "Admins can grant unit access" ON public.user_unit_access;
DROP POLICY IF EXISTS "Admins can update unit access" ON public.user_unit_access;
DROP POLICY IF EXISTS "Admins can revoke unit access" ON public.user_unit_access;
CREATE POLICY "Users, administrators and auditors can view unit access"
  ON public.user_unit_access FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR private.is_trust_admin(auth.uid())
         OR private.is_auditor(auth.uid())
         OR private.can_admin_unit(auth.uid(), unit_id));
CREATE POLICY "Administrators can grant unit access"
  ON public.user_unit_access FOR INSERT TO authenticated
  WITH CHECK (private.can_admin_unit(auth.uid(), unit_id));
CREATE POLICY "Administrators can update unit access"
  ON public.user_unit_access FOR UPDATE TO authenticated
  USING (private.can_admin_unit(auth.uid(), unit_id))
  WITH CHECK (private.can_admin_unit(auth.uid(), unit_id));
CREATE POLICY "Administrators can revoke unit access"
  ON public.user_unit_access FOR DELETE TO authenticated
  USING (private.can_admin_unit(auth.uid(), unit_id));

-- ===========================================================================
-- 7. Audit, access log and bridge oversight surfaces
-- ===========================================================================

DROP POLICY IF EXISTS "Admins can view account access events" ON public.account_access_events;
CREATE POLICY "Administrators and auditors can view account access events"
  ON public.account_access_events FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid())
         OR private.is_auditor(auth.uid())
         OR private.shares_admin_unit(auth.uid(), target_user_id));

DROP POLICY IF EXISTS "Audit readable by admins" ON public.audit_log;
CREATE POLICY "Administrators and auditors can read audit log"
  ON public.audit_log FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid())
         OR private.is_auditor(auth.uid())
         OR private.shares_admin_unit(auth.uid(), user_id));

DROP POLICY IF EXISTS "Admins can view audit" ON public.record_audit;
CREATE POLICY "Administrators and auditors can view record audit"
  ON public.record_audit FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()));

DROP POLICY IF EXISTS "Admins can view sync events" ON public.bridge_sync_events;
CREATE POLICY "Administrators and auditors can view sync events"
  ON public.bridge_sync_events FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()));

DROP POLICY IF EXISTS "Admins view bridge security events" ON public.bridge_security_events;
CREATE POLICY "Administrators and auditors view bridge security events"
  ON public.bridge_security_events FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()));

DROP POLICY IF EXISTS "Admins view bridge security alerts" ON public.bridge_security_alerts;
DROP POLICY IF EXISTS "Admins update bridge security alerts" ON public.bridge_security_alerts;
CREATE POLICY "Administrators and auditors view bridge security alerts"
  ON public.bridge_security_alerts FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()));
CREATE POLICY "Trust admins update bridge security alerts"
  ON public.bridge_security_alerts FOR UPDATE TO authenticated
  USING (private.is_trust_admin(auth.uid()))
  WITH CHECK (private.is_trust_admin(auth.uid()));

DROP POLICY IF EXISTS "Recipients read own delivery records" ON public.notification_deliveries;
CREATE POLICY "Recipients and Trust admins read delivery records"
  ON public.notification_deliveries FOR SELECT TO authenticated
  USING (recipient_id = auth.uid() OR private.is_trust_admin(auth.uid()));
