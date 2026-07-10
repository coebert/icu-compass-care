-- 1) Restrict referrals SELECT to clinical staff (was USING (true))
DROP POLICY IF EXISTS "Referrals readable by authenticated" ON public.referrals;
CREATE POLICY "Referrals readable by clinical staff"
  ON public.referrals
  FOR SELECT
  TO authenticated
  USING (private.has_clinical_access(auth.uid()));

-- 2) Prevent notification spoofing: clinical staff may only create notifications
--    addressed to themselves from the client. Cross-user notifications are
--    generated server-side via the service role (bypasses RLS).
DROP POLICY IF EXISTS "Notifications insertable by clinical staff" ON public.notifications;
CREATE POLICY "Notifications insertable by clinical staff"
  ON public.notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (private.has_clinical_access(auth.uid()) AND user_id = auth.uid());

-- 3) Remove the legacy public.has_role SECURITY DEFINER function that is
--    executable by signed-in users. First repoint the icu_beds policies (the
--    only remaining users, via unqualified has_role) to private.has_role.
DROP POLICY IF EXISTS "Admins can delete beds" ON public.icu_beds;
DROP POLICY IF EXISTS "Admins can insert beds" ON public.icu_beds;
DROP POLICY IF EXISTS "Admins can update beds" ON public.icu_beds;

CREATE POLICY "Admins can delete beds"
  ON public.icu_beds FOR DELETE TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can insert beds"
  ON public.icu_beds FOR INSERT TO authenticated
  WITH CHECK (private.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update beds"
  ON public.icu_beds FOR UPDATE TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (private.has_role(auth.uid(), 'admin'::app_role));

DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);