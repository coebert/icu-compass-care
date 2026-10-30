-- Security remediation round 3 (non-destructive: no rows deleted, no columns dropped).

-- ---------------------------------------------------------------------------
-- 1) Idle baseline for sessions without a guard row.
--    Enforcement is behind a switch so the still-published old client (which
--    never heartbeats) is not locked out mid-deployment. Flip it on right
--    after the reviewed frontend is published (see deployment-sequencing.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.security_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enforce_session_baseline boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO private.security_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
REVOKE ALL ON private.security_settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.session_baseline_enforced()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT enforce_session_baseline FROM private.security_settings WHERE id), false)
$$;

-- Activity baseline when no guard row exists: the time the auth session was
-- CREATED (i.e. the user authenticated). Token refreshes do not move it.
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
             AND (
               EXISTS (SELECT 1 FROM public.session_guard g0 WHERE g0.session_id = s.id)
               OR NOT private.session_baseline_enforced()
               OR s.created_at >= now() - private.session_idle_limit()
             )
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

CREATE OR REPLACE FUNCTION private.session_state_for_caller(_touch boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _uid uuid := auth.uid();
  _sid uuid := private.current_session_id();
  _created timestamptz;
  _g public.session_guard%ROWTYPE;
BEGIN
  IF _uid IS NULL OR _sid IS NULL THEN RETURN 'no_session'; END IF;
  SELECT s.created_at INTO _created FROM auth.sessions s
   WHERE s.id = _sid AND s.user_id = _uid AND (s.not_after IS NULL OR s.not_after > now());
  IF NOT FOUND THEN RETURN 'revoked'; END IF;
  SELECT * INTO _g FROM public.session_guard WHERE session_id = _sid FOR UPDATE;
  IF NOT FOUND THEN
    -- No recorded activity: judge idleness from authentication time. A
    -- heartbeat can never initialise an already-idle session as active.
    IF private.session_baseline_enforced()
       AND _created < now() - private.session_idle_limit() THEN
      INSERT INTO public.session_guard (session_id, user_id, last_activity_at, locked_at)
      VALUES (_sid, _uid, _created, now())
      ON CONFLICT (session_id) DO NOTHING;
      RETURN 'locked';
    END IF;
    IF _touch THEN
      INSERT INTO public.session_guard (session_id, user_id) VALUES (_sid, _uid)
      ON CONFLICT (session_id) DO NOTHING;
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

-- ---------------------------------------------------------------------------
-- 4) Last-admin protection counts only ENABLED (not banned / not deleted)
--    Trust administrators.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.account_enabled(_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = _user
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until <= now())
  )
$$;

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
      WHERE r.id <> OLD.id
        AND r.user_id <> OLD.user_id
        AND r.role IN ('trust_admin', 'admin')
        AND private.account_enabled(r.user_id)
    ) THEN
      RAISE EXCEPTION 'LAST_TRUST_ADMIN: at least one enabled Trust administrator must remain'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- Every write to roles / unit memberships (any role, incl. service role)
-- serialises on the same advisory lock as the admin RPCs.
CREATE OR REPLACE FUNCTION private.serialize_access_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('icu.user_roles.trust_admin_guard'));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS user_roles_serialize ON public.user_roles;
CREATE TRIGGER user_roles_serialize BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION private.serialize_access_change();
DROP TRIGGER IF EXISTS user_unit_access_serialize ON public.user_unit_access;
CREATE TRIGGER user_unit_access_serialize BEFORE INSERT OR UPDATE OR DELETE ON public.user_unit_access
  FOR EACH ROW EXECUTE FUNCTION private.serialize_access_change();

-- Mandatory audit for changes that bypass the admin RPCs (service role or the
-- transitional direct unit-access insert). Same transaction: audit failure
-- rolls the change back.
CREATE OR REPLACE FUNCTION private.audit_access_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _j jsonb;
BEGIN
  IF coalesce(current_setting('icu.access_change_audited', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN _j := to_jsonb(OLD); ELSE _j := to_jsonb(NEW); END IF;
  INSERT INTO public.account_access_events (action, target_user_id, role, reason, note, actor_id, actor_email)
  VALUES ('access_change', (_j ->> 'user_id')::uuid,
          _j ->> 'role',
          _j ->> 'reason',
          TG_TABLE_NAME || ' ' || lower(TG_OP)
            || coalesce(': unit ' || (_j ->> 'unit_id'), '')
            || ' (' || coalesce(auth.jwt() ->> 'role', current_user) || ')',
          auth.uid(), auth.jwt() ->> 'email');
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS user_roles_audit ON public.user_roles;
CREATE TRIGGER user_roles_audit AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION private.audit_access_change();
DROP TRIGGER IF EXISTS user_unit_access_audit ON public.user_unit_access;
CREATE TRIGGER user_unit_access_audit AFTER INSERT OR UPDATE OR DELETE ON public.user_unit_access
  FOR EACH ROW EXECUTE FUNCTION private.audit_access_change();

-- ---------------------------------------------------------------------------
-- 3) Authoritative admin transactions: lock FIRST, then session + recent
--    reauth + reason + target scope + suspension checks, mutation, audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.admin_change_preamble(_actor uuid, _reason text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF _actor IS NULL THEN RAISE EXCEPTION 'FORBIDDEN: not signed in' USING ERRCODE = '42501'; END IF;
  -- Serialise every admin access change before any permission is evaluated.
  PERFORM pg_advisory_xact_lock(hashtext('icu.user_roles.trust_admin_guard'));
  IF NOT private.session_active() THEN
    RAISE EXCEPTION 'SESSION_LOCKED: this session is locked or has ended' USING ERRCODE = '42501';
  END IF;
  IF NOT private.recent_reauth() THEN
    RAISE EXCEPTION 'REAUTH_REQUIRED: please confirm your password to continue' USING ERRCODE = '42501';
  END IF;
  IF _reason IS NULL OR length(btrim(_reason)) < 3 OR length(_reason) > 300 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: record a reason (3-300 characters)' USING ERRCODE = '22023';
  END IF;
  IF NOT private.account_enabled(_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN: your account is suspended' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('icu.access_change_audited', 'on', true);
END
$$;

CREATE OR REPLACE FUNCTION public.admin_replace_user_roles(
  _target uuid, _roles public.app_role[], _reason text, _action text DEFAULT 'role_changed')
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _actor uuid := auth.uid();
  _new public.app_role[] := coalesce(_roles, '{}'::public.app_role[]);
  _banned boolean;
BEGIN
  IF _action NOT IN ('role_changed', 'suspended', 'reinstated', 'deprovisioned', 'provisioned') THEN
    RAISE EXCEPTION 'INVALID_ACTION' USING ERRCODE = '22023';
  END IF;
  PERFORM private.admin_change_preamble(_actor, _reason);
  -- Re-checked under the lock: actor and target state as committed now.
  PERFORM 1 FROM public.user_roles WHERE user_id IN (_actor, _target) FOR UPDATE;
  PERFORM 1 FROM public.user_unit_access WHERE user_id IN (_actor, _target) FOR UPDATE;
  IF _actor = _target THEN
    RAISE EXCEPTION 'FORBIDDEN_TARGET: you cannot change your own access' USING ERRCODE = '42501';
  END IF;
  IF NOT private.can_manage_account(_actor, _target) THEN
    RAISE EXCEPTION 'FORBIDDEN_TARGET: that account is outside your administrative scope' USING ERRCODE = '42501';
  END IF;
  IF NOT private.is_trust_admin(_actor) AND EXISTS (
    SELECT 1 FROM unnest(_new) r WHERE r NOT IN ('clinician', 'unit_admin')) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: only a Trust administrator can assign that role' USING ERRCODE = '42501';
  END IF;
  SELECT NOT private.account_enabled(_target) INTO _banned;
  IF _action IN ('suspended', 'deprovisioned') AND cardinality(_new) > 0 THEN
    RAISE EXCEPTION 'INVALID_ACTION: suspension and removal strip all roles' USING ERRCODE = '22023';
  END IF;
  IF _action = 'reinstated' AND NOT _banned THEN
    RAISE EXCEPTION 'INVALID_ACTION: account is not suspended' USING ERRCODE = '22023';
  END IF;
  IF _banned AND cardinality(_new) > 0 AND _action <> 'reinstated' THEN
    RAISE EXCEPTION 'TARGET_SUSPENDED: reinstate the account before assigning roles' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
    SELECT _target, r FROM unnest(_new) r
    ON CONFLICT (user_id, role) DO NOTHING;
  DELETE FROM public.user_roles WHERE user_id = _target AND NOT (role = ANY (_new));

  INSERT INTO public.account_access_events
    (action, target_user_id, target_email, target_display_name, role, reason, actor_id, actor_email)
  SELECT _action, _target, u.email, u.raw_user_meta_data ->> 'display_name',
         CASE WHEN cardinality(_new) > 0 THEN array_to_string(_new, ',') END,
         btrim(_reason), _actor, auth.jwt() ->> 'email'
  FROM (SELECT 1) one LEFT JOIN auth.users u ON u.id = _target;
END
$$;
REVOKE ALL ON FUNCTION public.admin_replace_user_roles(uuid, public.app_role[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_user_roles(uuid, public.app_role[], text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_unit_access(
  _target uuid, _unit uuid, _grant boolean, _reason text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  _actor uuid := auth.uid();
  _n integer;
BEGIN
  PERFORM private.admin_change_preamble(_actor, _reason);
  PERFORM 1 FROM public.user_roles WHERE user_id IN (_actor, _target) FOR UPDATE;
  PERFORM 1 FROM public.user_unit_access WHERE user_id IN (_actor, _target) FOR UPDATE;
  IF NOT private.can_manage_unit_membership(_actor, _target, _unit) THEN
    RAISE EXCEPTION 'FORBIDDEN_TARGET: that account or unit is outside your administrative scope' USING ERRCODE = '42501';
  END IF;
  IF _grant AND NOT private.account_enabled(_target) THEN
    RAISE EXCEPTION 'TARGET_SUSPENDED: reinstate the account before granting access' USING ERRCODE = '42501';
  END IF;
  IF _grant THEN
    INSERT INTO public.user_unit_access (user_id, unit_id, granted_by, reason)
    VALUES (_target, _unit, _actor, btrim(_reason))
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.user_unit_access WHERE user_id = _target AND unit_id = _unit;
  END IF;
  GET DIAGNOSTICS _n = ROW_COUNT;
  INSERT INTO public.account_access_events
    (action, target_user_id, target_email, target_display_name, reason, note, actor_id, actor_email)
  SELECT CASE WHEN _grant THEN 'unit_granted' ELSE 'unit_revoked' END, _target, u.email,
         u.raw_user_meta_data ->> 'display_name', btrim(_reason),
         'unit ' || _unit::text || CASE WHEN _n = 0 THEN ' (no change)' ELSE '' END,
         _actor, auth.jwt() ->> 'email'
  FROM (SELECT 1) one LEFT JOIN auth.users u ON u.id = _target;
END
$$;
REVOKE ALL ON FUNCTION public.admin_set_unit_access(uuid, uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_unit_access(uuid, uuid, boolean, text) TO authenticated;

-- The reason-less RPC is retired: nothing the published build runs calls it.
REVOKE ALL ON FUNCTION public.replace_user_roles(uuid, public.app_role[]) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.replace_user_roles(uuid, public.app_role[]) IS
  'DEPRECATED: replaced by admin_replace_user_roles (reauth + reason + audit). Not executable by clients.';

-- Direct client writes to roles: none. All role changes go through the RPC
-- (or server-side service-role code, which the audit trigger records).
DROP POLICY IF EXISTS "Unit admins can grant unit roles to manageable accounts" ON public.user_roles;
DROP POLICY IF EXISTS "Unit admins can revoke unit roles from manageable accounts" ON public.user_roles;
DROP POLICY IF EXISTS "Trust admins can grant any role" ON public.user_roles;
DROP POLICY IF EXISTS "Trust admins can revoke any role" ON public.user_roles;
DROP POLICY IF EXISTS "Trust admins can update roles" ON public.user_roles;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.user_roles FROM anon, authenticated;

-- Unit memberships: UPDATE/DELETE only via RPC. A transitional direct INSERT
-- remains for the currently published client, now requiring an active
-- session, recent re-authentication and a recorded reason (audited by trigger).
DROP POLICY IF EXISTS "Administrators can update unit access for manageable accounts" ON public.user_unit_access;
DROP POLICY IF EXISTS "Administrators can revoke unit access for manageable accounts" ON public.user_unit_access;
DROP POLICY IF EXISTS "Administrators can grant unit access to manageable accounts" ON public.user_unit_access;
DROP POLICY IF EXISTS "Transitional: reauthenticated admins grant unit access" ON public.user_unit_access;
REVOKE UPDATE, DELETE, TRUNCATE ON public.user_unit_access FROM anon, authenticated;
CREATE POLICY "Transitional: reauthenticated admins grant unit access" ON public.user_unit_access
  FOR INSERT TO authenticated
  WITH CHECK (
    private.can_manage_unit_membership(auth.uid(), user_id, unit_id)
    AND private.session_active()
    AND private.recent_reauth()
    AND private.account_enabled(user_id)
    AND reason IS NOT NULL AND length(btrim(reason)) >= 3
  );
