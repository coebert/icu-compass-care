-- Minimal synthetic stand-in for the parts of the live schema the security
-- remediation migration builds on. Function bodies for the pre-existing
-- private.* helpers are copied verbatim from the live definitions so the
-- tests exercise the real authorisation logic. Contains NO live data.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA public, auth, private TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  not_after timestamptz
);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

CREATE TYPE public.app_role AS ENUM ('admin', 'clinician', 'unit_admin', 'trust_admin', 'auditor');
CREATE TYPE public.audit_action AS ENUM ('view', 'create', 'update', 'delete');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
CREATE TABLE public.hospitals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.icu_units (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, code text);
CREATE TABLE public.user_unit_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.icu_units(id),
  granted_by uuid, reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, unit_id)
);
CREATE TABLE public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.icu_units(id),
  shared_with_partner boolean NOT NULL DEFAULT false,
  full_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id),
  category text NOT NULL, findings text NOT NULL,
  result_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.handover_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_date date NOT NULL, shift text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(),
  label text NOT NULL, patient_count integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '[]', search_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (local_date, shift)
);
CREATE TABLE public.patient_field_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id),
  field_name text NOT NULL, old_value text, new_value text,
  changed_by uuid, changed_by_email text, changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.record_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL, record_id uuid NOT NULL, action text NOT NULL, source text NOT NULL,
  actor_id uuid, actor_role text, actor_email text,
  changed_fields text[] NOT NULL DEFAULT '{}', before jsonb, after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, action public.audit_action NOT NULL, entity text NOT NULL, entity_id uuid,
  diff jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
-- Passkey tables as on live (baseline 20260711092842 + 20260713083039).
CREATE TABLE public.webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE, public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0, transports text[] NOT NULL DEFAULT '{}',
  device_label text, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE TABLE public.webauthn_challenges (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge text NOT NULL, purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.account_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL, actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Mirror Supabase's default broad table grants (RLS is the gate).
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- ---- existing private helpers (verbatim bodies from live) ----
CREATE FUNCTION private.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;
CREATE FUNCTION private.is_trust_admin(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT private.has_role(_user_id, 'trust_admin') OR private.has_role(_user_id, 'admin');
$$;
CREATE FUNCTION private.is_auditor(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT private.has_role(_user_id, 'auditor');
$$;
CREATE FUNCTION private.has_clinical_access(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT private.has_role(_user_id, 'clinician') OR private.has_role(_user_id, 'unit_admin');
$$;
CREATE FUNCTION private.is_unit_member(_user_id uuid, _unit_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT _user_id IS NOT NULL AND _unit_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_unit_access ua WHERE ua.user_id = _user_id AND ua.unit_id = _unit_id);
$$;
CREATE FUNCTION private.can_edit_unit(_user_id uuid, _unit_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT (private.has_clinical_access(_user_id) AND private.is_unit_member(_user_id, _unit_id))
      OR private.is_trust_admin(_user_id);
$$;
CREATE FUNCTION private.can_view_unit(_user_id uuid, _unit_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT private.can_edit_unit(_user_id, _unit_id) OR private.is_trust_admin(_user_id);
$$;
CREATE FUNCTION private.can_admin_unit(_user_id uuid, _unit_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT private.is_trust_admin(_user_id)
      OR (private.has_role(_user_id, 'unit_admin') AND private.is_unit_member(_user_id, _unit_id));
$$;
CREATE FUNCTION private.can_view_patient(_user_id uuid, _patient_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = _patient_id AND private.can_view_unit(_user_id, p.unit_id));
$$;
CREATE FUNCTION private.can_access_patient(_user_id uuid, _patient_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = _patient_id AND private.can_edit_unit(_user_id, p.unit_id));
$$;
CREATE FUNCTION private.shares_admin_unit(_actor uuid, _target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT _actor IS NOT NULL AND _target IS NOT NULL AND private.has_role(_actor, 'unit_admin')
     AND EXISTS (SELECT 1 FROM public.user_unit_access a JOIN public.user_unit_access t ON t.unit_id = a.unit_id
                 WHERE a.user_id = _actor AND t.user_id = _target);
$$;

-- ---- existing policies the migration replaces (names as on live) ----
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Administrators and auditors can view roles" ON public.user_roles FOR SELECT TO authenticated USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()) OR private.shares_admin_unit(auth.uid(), user_id));
CREATE POLICY "Trust admins can grant any role" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (private.is_trust_admin(auth.uid()));
CREATE POLICY "Trust admins can revoke any role" ON public.user_roles FOR DELETE TO authenticated USING (private.is_trust_admin(auth.uid()));
CREATE POLICY "Unit admins can grant unit roles" ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (role IN ('clinician','unit_admin') AND private.shares_admin_unit(auth.uid(), user_id));
CREATE POLICY "Unit admins can revoke unit roles" ON public.user_roles FOR DELETE TO authenticated
  USING (role IN ('clinician','unit_admin') AND private.shares_admin_unit(auth.uid(), user_id));
ALTER TABLE public.user_unit_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users, administrators and auditors can view unit access" ON public.user_unit_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()) OR private.can_admin_unit(auth.uid(), unit_id));
CREATE POLICY "Administrators can grant unit access" ON public.user_unit_access FOR INSERT TO authenticated WITH CHECK (private.can_admin_unit(auth.uid(), unit_id));
CREATE POLICY "Administrators can update unit access" ON public.user_unit_access FOR UPDATE TO authenticated USING (private.can_admin_unit(auth.uid(), unit_id));
CREATE POLICY "Administrators can revoke unit access" ON public.user_unit_access FOR DELETE TO authenticated USING (private.can_admin_unit(auth.uid(), unit_id));
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view patients" ON public.patients FOR SELECT TO authenticated USING (private.can_view_unit(auth.uid(), unit_id));
ALTER TABLE public.investigations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view investigations" ON public.investigations FOR SELECT TO authenticated USING (private.can_view_patient(auth.uid(), patient_id));
ALTER TABLE public.handover_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Clinical staff and Trust admins can read handover versions" ON public.handover_versions FOR SELECT TO authenticated
  USING (private.has_clinical_access(auth.uid()) OR private.is_trust_admin(auth.uid()));
ALTER TABLE public.patient_field_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "No one can delete patient_field_changes" ON public.patient_field_changes FOR DELETE TO authenticated USING (false);
CREATE POLICY "Scoped staff can insert patient_field_changes" ON public.patient_field_changes FOR INSERT TO authenticated WITH CHECK (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff can update patient_field_changes" ON public.patient_field_changes FOR UPDATE TO authenticated
  USING (private.can_access_patient(auth.uid(), patient_id)) WITH CHECK (private.can_access_patient(auth.uid(), patient_id));
CREATE POLICY "Scoped staff, Trust admins and auditors can view edit history" ON public.patient_field_changes FOR SELECT TO authenticated
  USING (private.can_view_patient(auth.uid(), patient_id) OR private.is_auditor(auth.uid()));
ALTER TABLE public.record_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Administrators and auditors can view record audit" ON public.record_audit FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()));
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Administrators and auditors can read audit log" ON public.audit_log FOR SELECT TO authenticated
  USING (private.is_trust_admin(auth.uid()) OR private.is_auditor(auth.uid()) OR private.shares_admin_unit(auth.uid(), user_id));
CREATE POLICY "Audit insertable by authenticated" ON public.audit_log FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
ALTER TABLE public.account_access_events ENABLE ROW LEVEL SECURITY;
