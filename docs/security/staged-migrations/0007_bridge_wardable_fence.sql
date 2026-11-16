-- =============================================================================
-- STAGED — NOT APPLIED. Do not copy into drizzle/migrations or run until the
-- coordinated release gate authorises it (docs/security/deployment-sequencing.md).
-- Depends on: 0006 (private.bridge_unit_id). Apply after 0005 and 0006.
--
-- Fenced "ready for ward" (wardable) updates from Critical Care Connect.
-- Protocol: docs/bridge/wardable-protocol.md
--
-- CCC allocates a durable, per-patient, strictly increasing desired_revision
-- for every wardable intent. This app keeps a per-patient fence recording the
-- highest revision ever SEEN (reserved, even when the request could not be
-- applied) and the revision last APPLIED. A lower revision can therefore never
-- reverse a higher one, whatever order requests arrive in.
--
-- Non-destructive: adds one private table and one service-only function.
-- =============================================================================

CREATE TABLE IF NOT EXISTS private.bridge_wardable_fence (
  patient_id uuid PRIMARY KEY,
  highest_revision bigint NOT NULL CHECK (highest_revision > 0),
  highest_wardable boolean NOT NULL,
  applied_revision bigint CHECK (applied_revision IS NULL OR applied_revision > 0),
  applied_wardable boolean,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (applied_revision IS NULL OR applied_revision <= highest_revision),
  CHECK ((applied_revision IS NULL) = (applied_wardable IS NULL))
);
ALTER TABLE private.bridge_wardable_fence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.bridge_wardable_fence FROM PUBLIC, anon, authenticated, service_role;

-- The fence only ever moves forward and is never removed.
CREATE OR REPLACE FUNCTION private.bridge_wardable_fence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'wardable fence rows cannot be removed' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.highest_revision < OLD.highest_revision
     OR coalesce(NEW.applied_revision, 0) < coalesce(OLD.applied_revision, 0) THEN
    RAISE EXCEPTION 'wardable fence can only move forward' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS bridge_wardable_fence_guard_row ON private.bridge_wardable_fence;
CREATE TRIGGER bridge_wardable_fence_guard_row
  BEFORE UPDATE OR DELETE ON private.bridge_wardable_fence
  FOR EACH ROW EXECUTE FUNCTION private.bridge_wardable_fence_guard();
DROP TRIGGER IF EXISTS bridge_wardable_fence_guard_truncate ON private.bridge_wardable_fence;
CREATE TRIGGER bridge_wardable_fence_guard_truncate
  BEFORE TRUNCATE ON private.bridge_wardable_fence
  FOR EACH STATEMENT EXECUTE FUNCTION private.bridge_wardable_fence_guard();

-- ---------------------------------------------------------------------------
-- public.bridge_set_wardable
--   _desired_revision: canonical decimal string 1..9223372036854775807
--   _actor: the VERIFIED signed-envelope actor, passed by server code only
-- Returns jsonb, never raises for an ordinary conflict (raising would roll
-- back the fence reservation):
--   {ok:true,  status:'applied'|'already_applied', desired_revision, patient:{id,wardable,wardable_at,updated_at}}
--   {ok:false, code:'superseded'|'revision_conflict'|'intent_conflict'|'target_changed', desired_revision}
--   {ok:false, code:'not_found'}      (not in the bridge unit, not shared, or absent: no fence detail)
-- Raises PT400 invalid_request for malformed input, PT503 when the bridge
-- unit can't be resolved. Any failure while applying (including the audit
-- insert) raises and rolls back the whole call: no partial clinical state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_set_wardable(
  _patient_id uuid,
  _expected_updated_at timestamptz,
  _wardable boolean,
  _desired_revision text,
  _actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rev bigint;
  v_unit uuid;
  v_p record;
  v_f private.bridge_wardable_fence;
  v_after record;
  v_actor_id uuid;
  v_actor_role text;
  v_actor_email text;
BEGIN
  IF _patient_id IS NULL OR _expected_updated_at IS NULL OR _wardable IS NULL
     OR _desired_revision IS NULL OR _desired_revision !~ '^[1-9][0-9]{0,18}$'
     OR _desired_revision::numeric > 9223372036854775807 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;
  v_rev := _desired_revision::bigint;
  IF _actor IS NULL OR jsonb_typeof(_actor) <> 'object'
     OR coalesce(_actor ->> 'role', '') NOT IN ('admin', 'unit_admin', 'clinician') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;
  v_actor_role := _actor ->> 'role';
  v_actor_email := left(_actor ->> 'email', 320);
  BEGIN
    v_actor_id := nullif(_actor ->> 'id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_actor_id := NULL;
  END;

  v_unit := private.bridge_unit_id();

  -- Lock order: patient, then fence.
  SELECT p.id, p.wardable, p.wardable_at, p.updated_at INTO v_p
    FROM public.patients p
   WHERE p.id = _patient_id AND p.unit_id = v_unit AND p.shared_with_partner
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  SELECT * INTO v_f FROM private.bridge_wardable_fence f WHERE f.patient_id = _patient_id FOR UPDATE;
  IF FOUND THEN
    IF v_rev < v_f.highest_revision THEN
      RETURN jsonb_build_object('ok', false, 'code', 'superseded', 'desired_revision', v_f.highest_revision::text);
    END IF;
    IF v_rev = v_f.highest_revision THEN
      IF _wardable IS DISTINCT FROM v_f.highest_wardable THEN
        RETURN jsonb_build_object('ok', false, 'code', 'intent_conflict', 'desired_revision', v_f.highest_revision::text);
      END IF;
      IF v_f.applied_revision = v_rev THEN
        -- Never rewritten. Only "already applied" while it still holds.
        IF v_p.wardable IS NOT DISTINCT FROM v_f.applied_wardable THEN
          RETURN jsonb_build_object('ok', true, 'status', 'already_applied', 'desired_revision', v_rev::text,
            'patient', jsonb_build_object('id', v_p.id, 'wardable', v_p.wardable,
                                          'wardable_at', v_p.wardable_at, 'updated_at', v_p.updated_at));
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', 'target_changed', 'desired_revision', v_rev::text);
      END IF;
      -- Same pending intent: may apply only against the exact current version.
    ELSE
      UPDATE private.bridge_wardable_fence f
         SET highest_revision = v_rev, highest_wardable = _wardable, reserved_at = now()
       WHERE f.patient_id = _patient_id;
    END IF;
  ELSE
    INSERT INTO private.bridge_wardable_fence (patient_id, highest_revision, highest_wardable)
    VALUES (_patient_id, v_rev, _wardable);
  END IF;

  -- The reservation above is kept even when the patient version doesn't
  -- match: returning (not raising) commits it.
  IF v_p.updated_at IS DISTINCT FROM _expected_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'revision_conflict', 'desired_revision', v_rev::text);
  END IF;

  IF v_p.wardable IS DISTINCT FROM _wardable THEN
    UPDATE public.patients p
       SET wardable = _wardable,
           -- Trusted server clock; the partner can't supply it. wardable_by is
           -- a local user: a partner principal is recorded in the audit instead.
           wardable_at = CASE WHEN _wardable THEN now() ELSE NULL END,
           wardable_by = NULL
     WHERE p.id = _patient_id
    RETURNING p.id, p.wardable, p.wardable_at, p.updated_at INTO v_after;
    INSERT INTO public.record_audit
      (entity, record_id, action, source, actor_id, actor_role, actor_email, changed_fields, before, after)
    VALUES ('patients', _patient_id, 'update', 'bridge', v_actor_id, v_actor_role, v_actor_email,
            ARRAY['wardable', 'wardable_at'],
            jsonb_build_object('wardable', v_p.wardable, 'wardable_at', v_p.wardable_at),
            jsonb_build_object('wardable', v_after.wardable, 'wardable_at', v_after.wardable_at,
                               'desired_revision', v_rev::text));
  ELSE
    -- Already in the requested state: nothing clinical changes, but the
    -- revision is still marked applied so an older in-flight toggle can't
    -- reverse it later.
    v_after := v_p;
  END IF;

  UPDATE private.bridge_wardable_fence f
     SET applied_revision = v_rev, applied_wardable = _wardable, applied_at = now()
   WHERE f.patient_id = _patient_id;

  RETURN jsonb_build_object('ok', true, 'status', 'applied', 'desired_revision', v_rev::text,
    'patient', jsonb_build_object('id', v_after.id, 'wardable', v_after.wardable,
                                  'wardable_at', v_after.wardable_at, 'updated_at', v_after.updated_at));
END
$$;
REVOKE ALL ON FUNCTION public.bridge_set_wardable(uuid, timestamptz, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_set_wardable(uuid, timestamptz, boolean, text, jsonb) TO service_role;
