-- ============================================================
-- 1. Move SECURITY DEFINER helper functions out of the API-exposed
--    public schema into a private schema (not reachable via the Data API).
-- ============================================================
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION private.has_clinical_access(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT private.has_role(_user_id, 'admin') OR private.has_role(_user_id, 'clinician')
$$;

REVOKE ALL ON FUNCTION private.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.has_clinical_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION private.has_clinical_access(uuid) TO authenticated;

-- ============================================================
-- 2. Drop every policy that references the public helper functions
--    (must happen before dropping the functions).
-- ============================================================
DROP POLICY IF EXISTS "Audit readable by admins" ON public.audit_log;
DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Referrals deletable by admins" ON public.referrals;
DROP POLICY IF EXISTS "Admins can delete post-op bookings" ON public.postop_bookings;
DROP POLICY IF EXISTS "Clinicians can create post-op bookings" ON public.postop_bookings;
DROP POLICY IF EXISTS "Clinicians can update post-op bookings" ON public.postop_bookings;
DROP POLICY IF EXISTS "Clinicians can view post-op bookings" ON public.postop_bookings;
DROP POLICY IF EXISTS "Recipients read own delivery records" ON public.notification_deliveries;
DROP POLICY IF EXISTS "Admins can update ICNARC targets" ON public.icnarc_targets;
DROP POLICY IF EXISTS "Clinicians can read ICNARC targets" ON public.icnarc_targets;

-- Overly-permissive (USING/WITH CHECK true) policies to be replaced.
DROP POLICY IF EXISTS "Authenticated can view patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can insert patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can update patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can delete patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can view investigations" ON public.investigations;
DROP POLICY IF EXISTS "Authenticated can insert investigations" ON public.investigations;
DROP POLICY IF EXISTS "Authenticated can update investigations" ON public.investigations;
DROP POLICY IF EXISTS "Authenticated can delete investigations" ON public.investigations;
DROP POLICY IF EXISTS "Referrals insertable by authenticated" ON public.referrals;
DROP POLICY IF EXISTS "Referrals updatable by authenticated" ON public.referrals;
DROP POLICY IF EXISTS "Notifications insertable by authenticated" ON public.notifications;
DROP POLICY IF EXISTS "Authenticated can view sync events" ON public.bridge_sync_events;
DROP POLICY IF EXISTS "Authenticated can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated can view audit" ON public.record_audit;

-- ============================================================
-- 3. Drop the public helper functions (now flagged by the linter).
-- ============================================================
DROP FUNCTION IF EXISTS public.has_clinical_access(uuid);
DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);

-- Also stop anon/authenticated from calling the SECURITY DEFINER
-- signup trigger function directly via the API.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

-- ============================================================
-- 4. Recreate the helper-based policies using private.* functions.
-- ============================================================
CREATE POLICY "Audit readable by admins" ON public.audit_log
  FOR SELECT TO authenticated USING (private.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage roles" ON public.user_roles
  FOR ALL TO authenticated
  USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can view all roles" ON public.user_roles
  FOR SELECT TO authenticated USING (private.has_role(auth.uid(), 'admin'));

CREATE POLICY "Referrals deletable by admins" ON public.referrals
  FOR DELETE TO authenticated USING (private.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete post-op bookings" ON public.postop_bookings
  FOR DELETE TO authenticated USING (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Clinicians can create post-op bookings" ON public.postop_bookings
  FOR INSERT TO authenticated
  WITH CHECK (private.has_clinical_access(auth.uid()) AND created_by = auth.uid());
CREATE POLICY "Clinicians can update post-op bookings" ON public.postop_bookings
  FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinicians can view post-op bookings" ON public.postop_bookings
  FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND private.has_clinical_access(auth.uid()));

CREATE POLICY "Recipients read own delivery records" ON public.notification_deliveries
  FOR SELECT TO authenticated
  USING (recipient_id = auth.uid() OR private.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update ICNARC targets" ON public.icnarc_targets
  FOR UPDATE TO authenticated
  USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Clinicians can read ICNARC targets" ON public.icnarc_targets
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));

-- ============================================================
-- 5. Recreate the previously-permissive policies, scoped to clinical staff.
--    (All signed-in clinical staff share full access to patient data.)
-- ============================================================
CREATE POLICY "Clinical staff can view patients" ON public.patients
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patients" ON public.patients
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patients" ON public.patients
  FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patients" ON public.patients
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical staff can view investigations" ON public.investigations
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert investigations" ON public.investigations
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update investigations" ON public.investigations
  FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete investigations" ON public.investigations
  FOR DELETE TO authenticated USING (private.has_clinical_access(auth.uid()));

CREATE POLICY "Referrals insertable by clinical staff" ON public.referrals
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));
CREATE POLICY "Referrals updatable by clinical staff" ON public.referrals
  FOR UPDATE TO authenticated
  USING (private.has_clinical_access(auth.uid()))
  WITH CHECK (private.has_clinical_access(auth.uid()));

CREATE POLICY "Notifications insertable by clinical staff" ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (private.has_clinical_access(auth.uid()));

CREATE POLICY "Admins can view sync events" ON public.bridge_sync_events
  FOR SELECT TO authenticated USING (private.has_role(auth.uid(), 'admin'));

CREATE POLICY "Clinical staff can view profiles" ON public.profiles
  FOR SELECT TO authenticated USING (private.has_clinical_access(auth.uid()));

CREATE POLICY "Admins can view audit" ON public.record_audit
  FOR SELECT TO authenticated USING (private.has_role(auth.uid(), 'admin'));