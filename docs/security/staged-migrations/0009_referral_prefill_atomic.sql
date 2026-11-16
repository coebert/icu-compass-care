-- =============================================================================
-- STAGED — NOT APPLIED. Do not copy into drizzle/migrations or run until the
-- coordinated release gate authorises it (docs/security/deployment-sequencing.md).
-- Depends on: drizzle 0002-0004 (private.session_active, private.can_edit_unit),
-- staged 0006 (same per-referral advisory lock key as bridge_import_referral).
-- Apply order: 0005, 0006, 0007, 0008, 0009.
--
-- public.apply_referral_prefill(_actor, _session_id, _req): the ONLY write
-- path for "Fill blanks from linked referral". One transaction:
--   1. session + role + unit checks for the signed-in caller (the Hub server
--      passes the verified user and session from the caller's own token);
--   2. lock the source referral (same advisory key as the partner importer,
--      then the row FOR SHARE) and require it live at the previewed revision;
--   3. lock the target patient FOR UPDATE and require the previewed revision
--      and an existing exact link (patients.source_referral_id = referral);
--   4. require every target to be blank now (fill-blank-only) and offered by
--      that referral; an explicit true/false decision is never replaced;
--   5. write the patient, record_audit and patient_field_changes together.
-- Any failure writes nothing. Typed refusals are RETURNED (nothing written);
-- malformed input raises PT400.
--
-- Lock order (deadlock-free with every other path): advisory(referral) ->
-- referral row -> patient row. The importer takes advisory(referral) ->
-- referral row; bed moves and the wardable fence lock patients only and never
-- a referral; no path locks a patient and then a referral.
--
-- Service role only: the narrative fields are AES-GCM ciphertext produced by
-- the Hub server, so a browser must never call this directly with its own
-- values. Authenticated/anon have no EXECUTE.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.apply_referral_prefill(_actor uuid, _session_id uuid, _req jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_req_keys constant text[] := ARRAY['patient_id', 'referral_id', 'expected_patient_updated_at',
    'expected_referral_updated_at', 'set', 'dnacpr_decision'];
  c_text_fields constant text[] := ARRAY['current_admission', 'current_management', 'tep_details', 'dnacpr_details'];
  v_pid uuid;
  v_rid uuid;
  v_exp_p timestamptz;
  v_exp_r timestamptz;
  v_set jsonb;
  v_decision boolean;
  v_ref public.referrals;
  v_old public.patients;
  v_new public.patients;
  v_old_j jsonb;
  v_new_j jsonb;
  v_k text;
  v_v jsonb;
  v_offered boolean;
  v_changed text[] := ARRAY[]::text[];
  v_email text;
BEGIN
  -- ---- shape -------------------------------------------------------------
  IF _actor IS NULL OR _session_id IS NULL OR _req IS NULL OR jsonb_typeof(_req) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(_req) k WHERE k <> ALL (c_req_keys))
     OR jsonb_typeof(_req -> 'patient_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(_req -> 'referral_id') IS DISTINCT FROM 'string'
     OR NOT private.bridge_is_instant(_req ->> 'expected_patient_updated_at')
     OR NOT private.bridge_is_instant(_req ->> 'expected_referral_updated_at')
     OR jsonb_typeof(_req -> 'set') IS DISTINCT FROM 'object'
     OR coalesce(jsonb_typeof(_req -> 'dnacpr_decision'), 'null') NOT IN ('null', 'boolean') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;
  BEGIN
    v_pid := (_req ->> 'patient_id')::uuid;
    v_rid := (_req ->> 'referral_id')::uuid;
    v_exp_p := (_req ->> 'expected_patient_updated_at')::timestamptz;
    v_exp_r := (_req ->> 'expected_referral_updated_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END;
  v_set := _req -> 'set';
  v_decision := (_req ->> 'dnacpr_decision')::boolean;
  FOR v_k, v_v IN SELECT key, value FROM jsonb_each(v_set) LOOP
    -- Only these four ciphertext columns; bounded, non-empty strings.
    IF v_k <> ALL (c_text_fields) OR jsonb_typeof(v_v) <> 'string'
       OR length(v_v #>> '{}') NOT BETWEEN 1 AND 20000 THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
    END IF;
  END LOOP;
  IF v_set = '{}'::jsonb AND v_decision IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;

  -- ---- who is asking -------------------------------------------------------
  -- Evaluate the caller's own session with the authoritative session rules
  -- (same functions RLS uses), then confirm they really resolved to it.
  PERFORM set_config('request.jwt.claim.sub', _actor::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', _actor, 'role', 'authenticated', 'session_id', _session_id)::text, true);
  IF auth.uid() IS DISTINCT FROM _actor
     OR private.current_session_id() IS DISTINCT FROM _session_id
     OR NOT private.session_active() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authorised');
  END IF;

  -- ---- source referral: lock, live, previewed revision ---------------------
  PERFORM pg_advisory_xact_lock(hashtextextended('bridge_import_referral:' || v_rid::text, 0));
  SELECT * INTO v_ref FROM public.referrals r WHERE r.id = v_rid FOR SHARE;
  IF NOT FOUND OR v_ref.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'referral_unavailable');
  END IF;
  IF v_ref.updated_at IS DISTINCT FROM v_exp_r THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  -- ---- target patient: lock, scope, link, previewed revision ---------------
  -- Out-of-scope and nonexistent patients look the same.
  SELECT * INTO v_old FROM public.patients p
   WHERE p.id = v_pid AND private.can_edit_unit(_actor, p.unit_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_old.source_referral_id IS DISTINCT FROM v_rid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'link_required');
  END IF;
  IF v_old.updated_at IS DISTINCT FROM v_exp_p THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  -- ---- fill-blank-only, and only what this referral offers -----------------
  v_old_j := to_jsonb(v_old);
  FOR v_k IN SELECT key FROM jsonb_each(v_set) ORDER BY key LOOP
    IF (v_old_j ->> (v_k || '_enc')) IS NOT NULL
       OR coalesce(btrim(v_old_j ->> v_k), '') <> '' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'stale');
    END IF;
    v_offered := CASE v_k
      WHEN 'current_admission' THEN v_ref.reason_category IS NOT NULL
      WHEN 'current_management' THEN cardinality(v_ref.anticipated_interventions) > 0
        OR coalesce(btrim(v_ref.allergies), '') <> '' OR v_ref.weight_kg IS NOT NULL
        OR v_ref.admission_urgency IS NOT NULL
      WHEN 'tep_details' THEN v_ref.ceiling_of_care IS NOT NULL OR v_ref.resus_status IS NOT NULL
        OR v_ref.dnacpr_respect
      WHEN 'dnacpr_details' THEN v_ref.resus_status::text = 'dnacpr'
      ELSE false END;
    IF NOT coalesce(v_offered, false) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'stale');
    END IF;
    v_changed := array_append(v_changed, v_k);
  END LOOP;
  IF v_decision IS NOT NULL THEN
    -- Only an unset (NULL) decision, and only the referral's explicit status.
    -- An explicit false or true is never replaced; ReSPECT is not DNACPR.
    IF v_old.dnacpr_decision IS NOT NULL
       OR v_decision IS DISTINCT FROM (CASE v_ref.resus_status::text
            WHEN 'dnacpr' THEN true WHEN 'for_cpr' THEN false END) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'stale');
    END IF;
    v_changed := array_append(v_changed, 'dnacpr_decision');
  END IF;

  -- ---- write (row already locked; predicate kept as a belt-and-braces CAS) -
  UPDATE public.patients p SET
    current_admission = CASE WHEN v_set ? 'current_admission' THEN NULL ELSE p.current_admission END,
    current_admission_enc = CASE WHEN v_set ? 'current_admission' THEN v_set ->> 'current_admission' ELSE p.current_admission_enc END,
    current_management = CASE WHEN v_set ? 'current_management' THEN NULL ELSE p.current_management END,
    current_management_enc = CASE WHEN v_set ? 'current_management' THEN v_set ->> 'current_management' ELSE p.current_management_enc END,
    tep_details = CASE WHEN v_set ? 'tep_details' THEN NULL ELSE p.tep_details END,
    tep_details_enc = CASE WHEN v_set ? 'tep_details' THEN v_set ->> 'tep_details' ELSE p.tep_details_enc END,
    dnacpr_details = CASE WHEN v_set ? 'dnacpr_details' THEN NULL ELSE p.dnacpr_details END,
    dnacpr_details_enc = CASE WHEN v_set ? 'dnacpr_details' THEN v_set ->> 'dnacpr_details' ELSE p.dnacpr_details_enc END,
    dnacpr_decision = coalesce(v_decision, p.dnacpr_decision),
    updated_by = _actor
   WHERE p.id = v_pid AND p.updated_at = v_exp_p AND p.source_referral_id = v_rid
  RETURNING * INTO v_new;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;
  v_new_j := to_jsonb(v_new);

  -- ---- audit, same transaction: a failure here rolls the write back --------
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = _actor;
  INSERT INTO public.record_audit
    (entity, record_id, action, source, actor_id, actor_role, actor_email, changed_fields, before, after)
  VALUES ('patients', v_pid, 'update', 'app', _actor, NULL, v_email, v_changed, v_old_j,
          v_new_j || jsonb_build_object('operation', 'referral_prefill', 'referral_id', v_rid,
                                        'referral_revision', v_ref.updated_at));
  -- Field history: narrative values stay sealed (the same ciphertext).
  FOREACH v_k IN ARRAY v_changed LOOP
    INSERT INTO public.patient_field_changes (patient_id, field_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (v_pid, v_k,
            CASE WHEN v_k = 'dnacpr_decision' THEN v_old.dnacpr_decision::text END,
            CASE WHEN v_k = 'dnacpr_decision' THEN v_new.dnacpr_decision::text ELSE v_new_j ->> (v_k || '_enc') END,
            _actor, v_email);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied_fields', to_jsonb(v_changed), 'patient', v_new_j);
END
$$;
REVOKE ALL ON FUNCTION public.apply_referral_prefill(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_referral_prefill(uuid, uuid, jsonb) TO service_role;
