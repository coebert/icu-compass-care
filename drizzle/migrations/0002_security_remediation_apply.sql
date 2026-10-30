-- Security remediation F1-F6 (non-destructive: no rows deleted, no tables or
-- columns dropped; legacy data is quarantined rather than migrated).

-- F6: server-side session guard
CREATE TABLE IF NOT EXISTS public.session_guard (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.session_guard TO service_role;
REVOKE ALL ON public.session_guard FROM anon, authenticated;
ALTER TABLE public.session_guard ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS session_guard_user_idx ON public.session_guard (user_id);
COMMENT ON TABLE public.session_guard IS
  'Server-side lock/idle state per auth session. Written only by SECURITY DEFINER functions and the service role.';

CREATE OR REPLACE FUNCTION private.session_idle_limit()
RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '15 minutes' $$;

CREATE OR REPLACE FUNCTION private.current_session_id()
RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (auth.jwt() ->> 'session_id')::uuid
  END
$$;

CREATE OR REPLACE FUNCTION private.session_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN true
    WHEN private.current_session_id() IS NULL THEN false
    ELSE EXISTS (
           SELECT 1 FROM auth.sessions s
           WHERE s.id = private.current_session_id()
             AND s.user_id = auth.uid()
             AND (s.not_after IS NULL OR s.not_after > now())
         )
     AND NOT EXISTS (
           SELECT 1 FROM public.session_guard g
           WHERE g.session_id = private.current_session_id()
             AND (g.user_id <> auth.uid()
                  OR g.locked_at IS NOT NULL
                  OR g.last_activity_at < now() - private.session_idle_limit())
         )
  END
$$;

CREATE OR REPLACE FUNCTION private.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
     AND (_user_id IS DISTINCT FROM auth.uid() OR private.session_active())
$$;

CREATE OR REPLACE FUNCTION private.session_state_for_caller(_touch boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _uid uuid := auth.uid();
  _sid uuid := private.current_session_id();
  _g public.session_guard%ROWTYPE;
BEGIN
  IF _uid IS NULL OR _sid IS NULL THEN RETURN 'no_session'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = _sid AND s.user_id = _uid AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN 'revoked';
  END IF;
  SELECT * INTO _g FROM public.session_guard WHERE session_id = _sid FOR UPDATE;
  IF NOT FOUND THEN
    IF _touch THEN
      INSERT INTO public.session_guard (session_id, user_id) VALUES (_sid, _uid);
    END IF;
    RETURN 'active';
  END IF;
  IF _g.user_id <> _uid THEN RETURN 'revoked'; END IF;
  IF _g.locked_at IS NOT NULL THEN RETURN 'locked'; END IF;
  IF _g.last_activity_at < now() - private.session_idle_limit() THEN
    UPDATE public.session_guard SET locked_at = now(), updated_at = now() WHERE session_id = _sid;
    RETURN 'locked';
  END IF;
  IF _touch THEN
    UPDATE public.session_guard SET last_activity_at = now(), updated_at = now() WHERE session_id = _sid;
  END IF;
  RETURN 'active';
END
$$;

CREATE OR REPLACE FUNCTION public.session_heartbeat()
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.session_state_for_caller(true)
$$;

CREATE OR REPLACE FUNCTION public.session_status()
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.session_state_for_caller(false)
$$;

CREATE OR REPLACE FUNCTION public.session_lock()
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _uid uuid := auth.uid();
  _sid uuid := private.current_session_id();
BEGIN
  IF _uid IS NULL OR _sid IS NULL THEN RETURN 'no_session'; END IF;
  INSERT INTO public.session_guard (session_id, user_id, locked_at)
  VALUES (_sid, _uid, now())
  ON CONFLICT (session_id) DO UPDATE
    SET locked_at = now(), updated_at = now()
    WHERE public.session_guard.user_id = _uid;
  RETURN 'locked';
END
$$;

CREATE OR REPLACE FUNCTION public.session_unlock(_session_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = _session_id AND s.user_id = _user_id AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.session_guard (session_id, user_id)
  VALUES (_session_id, _user_id)
  ON CONFLICT (session_id) DO UPDATE
    SET locked_at = NULL, last_activity_at = now(), updated_at = now()
    WHERE public.session_guard.user_id = _user_id;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.session_heartbeat() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.session_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.session_lock() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.session_unlock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_heartbeat() TO authenticated;
GRANT EXECUTE ON FUNCTION public.session_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.session_lock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.session_unlock(uuid, uuid) TO service_role;

-- F1/F2: target-aware account management
CREATE OR REPLACE FUNCTION private.is_privileged_account(_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user AND role IN ('trust_admin', 'admin', 'auditor')
  )
$$;

CREATE OR REPLACE FUNCTION private.can_manage_account(_actor uuid, _target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT _actor IS NOT NULL AND _target IS NOT NULL AND _actor <> _target
     AND (
       private.is_trust_admin(_actor)
       OR (
         private.has_role(_actor, 'unit_admin')
         AND NOT private.is_privileged_account(_target)
         AND EXISTS (SELECT 1 FROM public.user_unit_access t WHERE t.user_id = _target)
         AND NOT EXISTS (
           SELECT 1 FROM public.user_unit_access t
           WHERE t.user_id = _target
             AND NOT private.is_unit_member(_actor, t.unit_id)
         )
       )
     )
$$;

CREATE OR REPLACE FUNCTION private.can_manage_unit_membership(_actor uuid, _target uuid, _unit uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT _actor IS NOT NULL AND _target IS NOT NULL AND _unit IS NOT NULL
     AND (
       private.is_trust_admin(_actor)
       OR (
         _actor <> _target
         AND private.has_role(_actor, 'unit_admin')
         AND private.is_unit_member(_actor, _unit)
         AND NOT private.is_privileged_account(_target)
       )
     )
$$;

CREATE OR REPLACE FUNCTION public.can_manage_account(_target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.can_manage_account(auth.uid(), _target)
$$;
REVOKE ALL ON FUNCTION public.can_manage_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_account(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.guard_last_trust_admin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.role IN ('trust_admin', 'admin')
     AND (TG_OP = 'DELETE'
          OR NEW.role NOT IN ('trust_admin', 'admin')
          OR NEW.user_id <> OLD.user_id) THEN
    PERFORM pg_advisory_xact_lock(hashtext('icu.user_roles.trust_admin_guard'));
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles r
      WHERE r.id <> OLD.id AND r.role IN ('trust_admin', 'admin')
    ) THEN
      RAISE EXCEPTION 'LAST_TRUST_ADMIN: at least one Trust administrator must remain'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS user_roles_guard_last_trust_admin ON public.user_roles;
CREATE TRIGGER user_roles_guard_last_trust_admin
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION private.guard_last_trust_admin();

CREATE OR REPLACE FUNCTION public.replace_user_roles(_target uuid, _roles public.app_role[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _actor uuid := auth.uid();
  _new public.app_role[] := coalesce(_roles, '{}'::public.app_role[]);
BEGIN
  IF NOT private.can_manage_account(_actor, _target) THEN
    RAISE EXCEPTION 'FORBIDDEN_TARGET: that account is outside your administrative scope'
      USING ERRCODE = '42501';
  END IF;
  IF NOT private.is_trust_admin(_actor) AND EXISTS (
    SELECT 1 FROM unnest(_new) r WHERE r NOT IN ('clinician', 'unit_admin')
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: only a Trust administrator can assign that role'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('icu.user_roles.trust_admin_guard'));
  PERFORM 1 FROM public.user_roles WHERE user_id = _target FOR UPDATE;
  INSERT INTO public.user_roles (user_id, role)
    SELECT _target, r FROM unnest(_new) r
    ON CONFLICT (user_id, role) DO NOTHING;
  DELETE FROM public.user_roles WHERE user_id = _target AND NOT (role = ANY (_new));
END
$$;
REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, public.app_role[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_user_roles(uuid, public.app_role[]) TO authenticated;

DROP POLICY IF EXISTS "Unit admins can grant unit roles" ON public.user_roles;
DROP POLICY IF EXISTS "Unit admins can revoke unit roles" ON public.user_roles;
CREATE POLICY "Unit admins can grant unit roles to manageable accounts" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (role IN ('clinician', 'unit_admin') AND private.can_manage_account(auth.uid(), user_id));
CREATE POLICY "Unit admins can revoke unit roles from manageable accounts" ON public.user_roles
  FOR DELETE TO authenticated
  USING (role IN ('clinician', 'unit_admin') AND private.can_manage_account(auth.uid(), user_id));

DROP POLICY IF EXISTS "Administrators can grant unit access" ON public.user_unit_access;
DROP POLICY IF EXISTS "Administrators can update unit access" ON public.user_unit_access;
DROP POLICY IF EXISTS "Administrators can revoke unit access" ON public.user_unit_access;
CREATE POLICY "Administrators can grant unit access to manageable accounts" ON public.user_unit_access
  FOR INSERT TO authenticated
  WITH CHECK (private.can_manage_unit_membership(auth.uid(), user_id, unit_id));
CREATE POLICY "Administrators can update unit access for manageable accounts" ON public.user_unit_access
  FOR UPDATE TO authenticated
  USING (private.can_manage_unit_membership(auth.uid(), user_id, unit_id))
  WITH CHECK (private.can_manage_unit_membership(auth.uid(), user_id, unit_id));
CREATE POLICY "Administrators can revoke unit access for manageable accounts" ON public.user_unit_access
  FOR DELETE TO authenticated
  USING (private.can_manage_unit_membership(auth.uid(), user_id, unit_id));

CREATE TABLE IF NOT EXISTS private.bootstrap_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  sealed_at timestamptz NOT NULL DEFAULT now(),
  sealed_by uuid
);
REVOKE ALL ON private.bootstrap_state FROM PUBLIC, anon, authenticated;
INSERT INTO private.bootstrap_state (id, sealed_at)
  SELECT true, now()
  WHERE EXISTS (SELECT 1 FROM public.user_roles) OR EXISTS (SELECT 1 FROM auth.users)
  ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.bootstrap_sealed()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM private.bootstrap_state)
$$;

CREATE OR REPLACE FUNCTION public.complete_bootstrap(_user uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  LOCK TABLE private.bootstrap_state IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM private.bootstrap_state) THEN
    RAISE EXCEPTION 'BOOTSTRAP_SEALED' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id <> _user)
     OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id <> _user) THEN
    RAISE EXCEPTION 'BOOTSTRAP_SEALED: other accounts already exist' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (_user, 'trust_admin'), (_user, 'unit_admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  INSERT INTO private.bootstrap_state (id, sealed_by) VALUES (true, _user);
END
$$;
REVOKE ALL ON FUNCTION public.bootstrap_sealed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_bootstrap(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_sealed() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_bootstrap(uuid) TO service_role;

-- F3: unit-scoped handover snapshots
CREATE TABLE IF NOT EXISTS public.handover_unit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.icu_units(id),
  local_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('am', 'pm')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  label text NOT NULL,
  patient_count integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handover_unit_versions_date_shift_unit_key UNIQUE (local_date, shift, unit_id)
);
GRANT SELECT ON public.handover_unit_versions TO authenticated;
GRANT ALL ON public.handover_unit_versions TO service_role;
REVOKE ALL ON public.handover_unit_versions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.handover_unit_versions FROM authenticated;
ALTER TABLE public.handover_unit_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Unit staff and Trust admins can read their unit handover versions"
  ON public.handover_unit_versions FOR SELECT TO authenticated
  USING (private.can_view_unit(auth.uid(), unit_id));
CREATE INDEX IF NOT EXISTS handover_unit_versions_unit_date_idx
  ON public.handover_unit_versions (unit_id, local_date DESC, shift DESC);

DROP POLICY IF EXISTS "Clinical staff and Trust admins can read handover versions" ON public.handover_versions;
CREATE POLICY "Trust admins can read legacy mixed-unit handover versions"
  ON public.handover_versions FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()));
REVOKE ALL ON public.handover_versions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.handover_versions FROM authenticated;
COMMENT ON TABLE public.handover_versions IS
  'DEPRECATED: legacy mixed-unit snapshots, quarantined to Trust administrators; replaced by handover_unit_versions';

-- F4: edit history + audit tables
DROP POLICY IF EXISTS "Scoped staff, Trust admins and auditors can view edit history" ON public.patient_field_changes;
DROP POLICY IF EXISTS "Scoped staff can update patient_field_changes" ON public.patient_field_changes;
CREATE POLICY "Staff who can see the patient can view edit history"
  ON public.patient_field_changes FOR SELECT TO authenticated
  USING (private.can_view_patient(auth.uid(), patient_id));
REVOKE ALL ON public.patient_field_changes FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.patient_field_changes FROM authenticated;

DROP POLICY IF EXISTS "Administrators and auditors can view record audit" ON public.record_audit;
CREATE POLICY "Trust admins can view full record audit"
  ON public.record_audit FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()));
REVOKE ALL ON public.record_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.record_audit FROM authenticated;

DROP POLICY IF EXISTS "Administrators and auditors can read audit log" ON public.audit_log;
CREATE POLICY "Trust admins and authors can read audit log"
  ON public.audit_log FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR user_id = auth.uid());
REVOKE ALL ON public.audit_log FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM authenticated;

REVOKE ALL ON public.account_access_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.account_access_events FROM authenticated;

CREATE OR REPLACE FUNCTION public.audit_record_metadata(_entity text DEFAULT NULL, _record_id uuid DEFAULT NULL, _limit integer DEFAULT 100)
RETURNS TABLE (id uuid, entity text, record_id uuid, action text, source text, actor_id uuid,
               actor_role text, actor_email text, changed_fields text[], created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (private.is_auditor(auth.uid()) OR private.is_trust_admin(auth.uid())) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.entity, a.record_id, a.action, a.source, a.actor_id,
           a.actor_role, a.actor_email, a.changed_fields, a.created_at
    FROM public.record_audit a
    WHERE (_entity IS NULL OR a.entity = _entity)
      AND (_record_id IS NULL OR a.record_id = _record_id)
    ORDER BY a.created_at DESC
    LIMIT least(greatest(coalesce(_limit, 100), 1), 500);
END
$$;

CREATE OR REPLACE FUNCTION public.audit_field_change_metadata(_patient_id uuid DEFAULT NULL, _limit integer DEFAULT 100)
RETURNS TABLE (id uuid, patient_id uuid, field_name text, changed_by uuid, changed_by_email text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (private.is_auditor(auth.uid()) OR private.is_trust_admin(auth.uid())) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT f.id, f.patient_id, f.field_name, f.changed_by, f.changed_by_email, f.changed_at
    FROM public.patient_field_changes f
    WHERE (_patient_id IS NULL OR f.patient_id = _patient_id)
    ORDER BY f.changed_at DESC
    LIMIT least(greatest(coalesce(_limit, 100), 1), 500);
END
$$;

CREATE OR REPLACE FUNCTION public.audit_log_metadata(_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, user_id uuid, action public.audit_action, entity text, entity_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (private.is_auditor(auth.uid()) OR private.is_trust_admin(auth.uid())) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.id, l.user_id, l.action, l.entity, l.entity_id, l.created_at
    FROM public.audit_log l
    ORDER BY l.created_at DESC
    LIMIT least(greatest(coalesce(_limit, 100), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.audit_record_metadata(text, uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.audit_field_change_metadata(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.audit_log_metadata(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_record_metadata(text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_field_change_metadata(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_log_metadata(integer) TO authenticated;

-- F5: bridge writes gated on partner sharing, atomically
CREATE OR REPLACE FUNCTION public.bridge_insert_investigation(
  _patient_id uuid, _category text, _findings text, _result_at timestamptz)
RETURNS SETOF public.investigations LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.patients p WHERE p.id = _patient_id AND p.shared_with_partner FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    INSERT INTO public.investigations (patient_id, category, findings, result_at)
    VALUES (_patient_id, _category, _findings, coalesce(_result_at, now()))
    RETURNING *;
END
$$;
REVOKE ALL ON FUNCTION public.bridge_insert_investigation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_insert_investigation(uuid, text, text, timestamptz) TO service_role;
