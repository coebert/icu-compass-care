-- =============================================================================
-- STAGED — NOT APPLIED. Do not copy into drizzle/migrations or run until the
-- coordinated release gate authorises it (docs/security/deployment-sequencing.md).
-- Depends on: drizzle 0002-0004. Independent of 0005; apply 0005, 0006, 0007 in order.
--
-- Partner (Critical Care Connect, "CCC") import helpers for the sync v1 contract.
--
-- * private.bridge_unit_id(): the ONE unit the partner bridge serves
--   (code SDH-RADNOR), resolved inside every helper. No caller-supplied unit.
-- * private.bridge_referral_provenance: protected ledger of what was imported
--   from CCC — the SOURCE revision, and the local (receiver) revision our
--   own write produced. Ordinary referrals.updated_at touch triggers are left
--   exactly as they are; nothing can preserve or spoof updated_at.
-- * public.bridge_import_referral(jsonb): allowlisted import with provenance.
--   A local row without provenance (legacy, or created here) is a conflict,
--   never adopted. Content, provenance and audit commit together or not at all.
-- * public.bridge_import_result(text, jsonb): new-id-only result import for an
--   existing, still-shared patient in the bridge unit, audited atomically.
-- * public.bridge_insert_investigation: existing helper, now restricted to the
--   bridge unit as well as sharing (same signature, same service-only grant).
--
-- Non-destructive: adds one private table and replaces helper functions. No
-- existing rows are changed.
-- =============================================================================

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.icu_units WHERE code = 'SDH-RADNOR';
  IF n <> 1 THEN
    RAISE EXCEPTION 'bridge preflight failed: expected exactly one SDH-RADNOR unit, found %. Nothing was changed.', n;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private.bridge_unit_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n int;
  v_id text;
BEGIN
  SELECT count(*), min(u.id::text) INTO v_n, v_id FROM public.icu_units u WHERE u.code = 'SDH-RADNOR';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'bridge_unit_unavailable' USING ERRCODE = 'PT503';
  END IF;
  RETURN v_id::uuid;
END
$$;
REVOKE ALL ON FUNCTION private.bridge_unit_id() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Provenance ledger (private schema, no table grants: only the SECURITY
-- DEFINER helpers below can read or write it).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private.bridge_referral_provenance (
  referral_id uuid PRIMARY KEY,
  source_revision timestamptz NOT NULL,
  receiver_revision timestamptz NOT NULL,
  source_deleted_at timestamptz,
  first_imported_at timestamptz NOT NULL DEFAULT now(),
  last_imported_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.bridge_referral_provenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.bridge_referral_provenance FROM PUBLIC, anon, authenticated, service_role;

-- Never-applied earlier staged signatures (defensive; no-ops on live).
DROP FUNCTION IF EXISTS public.bridge_import_referral(jsonb, timestamptz);
DROP FUNCTION IF EXISTS public.bridge_import_result(text, jsonb, uuid);

-- Allowlisted, comparable view of a referral row (what import may write).
CREATE OR REPLACE FUNCTION private.referral_import_fields(_r public.referrals)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'deleted_at', _r.deleted_at, 'status', _r.status,
    'referral_received_at', _r.referral_received_at, 'age', _r.age, 'sex', _r.sex,
    'current_ward', _r.current_ward, 'current_bed', _r.current_bed,
    'referring_specialty', _r.referring_specialty, 'reason_category', _r.reason_category,
    'ceiling_of_care', _r.ceiling_of_care, 'resus_status', _r.resus_status,
    'dnacpr_respect', _r.dnacpr_respect, 'anticipated_interventions', _r.anticipated_interventions,
    'allergies', _r.allergies, 'weight_kg', _r.weight_kg,
    'admission_urgency', _r.admission_urgency, 'infection_status', _r.infection_status,
    'news2_score', _r.news2_score)
$$;
REVOKE ALL ON FUNCTION private.referral_import_fields(public.referrals) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Referral import.
-- _rec is EITHER a live row (every allowlisted key present, deleted_at: null)
-- OR a minimal tombstone {id, updated_at, deleted_at} with deleted_at set.
-- Returns: inserted | updated | restored | deleted | unchanged |
--          unknown_tombstone | conflict.   Malformed input raises PT400.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_import_referral(_rec jsonb)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_live_keys constant text[] := ARRAY[
    'id', 'created_at', 'updated_at', 'deleted_at', 'status', 'referral_received_at', 'age', 'sex',
    'current_ward', 'current_bed', 'referring_specialty', 'reason_category', 'ceiling_of_care',
    'resus_status', 'dnacpr_respect', 'anticipated_interventions', 'allergies', 'weight_kg',
    'admission_urgency', 'infection_status', 'news2_score'];
  v_id uuid;
  v_src_rev timestamptz;
  v_src_deleted timestamptz;
  v_tomb boolean;
  v_row public.referrals;
  v_cur public.referrals;
  v_has_cur boolean;
  v_prov private.bridge_referral_provenance;
  v_has_prov boolean;
  v_recv timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_result text;
BEGIN
  IF _rec IS NULL OR jsonb_typeof(_rec) <> 'object'
     OR jsonb_typeof(_rec -> 'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(_rec -> 'updated_at') IS DISTINCT FROM 'string'
     OR NOT (_rec ? 'deleted_at') THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
  END IF;
  BEGIN
    v_id := (_rec ->> 'id')::uuid;
    v_src_rev := (_rec ->> 'updated_at')::timestamptz;
    v_src_deleted := (_rec ->> 'deleted_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
  END;
  v_tomb := v_src_deleted IS NOT NULL;

  IF v_tomb THEN
    -- Minimal tombstone: exactly these three keys, nothing else is read.
    IF (SELECT count(*) FROM jsonb_object_keys(_rec)) <> 3 THEN
      RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
    END IF;
  ELSE
    IF jsonb_typeof(_rec -> 'deleted_at') <> 'null' OR NOT (_rec ?& c_live_keys)
       OR jsonb_typeof(_rec -> 'created_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(_rec -> 'referral_received_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(_rec -> 'status') IS DISTINCT FROM 'string'
       OR jsonb_typeof(_rec -> 'dnacpr_respect') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(_rec -> 'anticipated_interventions') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
    END IF;
    BEGIN
      -- Explicit allowlist: *_enc, *_hash, created_by/updated_by/deleted_by,
      -- origin_booking_id and previous_referral_id can never be written here.
      v_row := jsonb_populate_record(NULL::public.referrals, (
        SELECT jsonb_object_agg(k, _rec -> k) FROM unnest(c_live_keys) k));
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
    END;
    IF v_row.created_at IS NULL OR v_row.referral_received_at IS NULL OR v_row.status IS NULL
       OR v_row.dnacpr_respect IS NULL OR v_row.anticipated_interventions IS NULL THEN
      RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
    END IF;
  END IF;

  -- One importer per referral id at a time (also covers "no row yet").
  PERFORM pg_advisory_xact_lock(hashtextextended('bridge_import_referral:' || v_id::text, 0));
  SELECT * INTO v_cur FROM public.referrals r WHERE r.id = v_id FOR UPDATE;
  v_has_cur := FOUND;
  SELECT * INTO v_prov FROM private.bridge_referral_provenance p WHERE p.referral_id = v_id FOR UPDATE;
  v_has_prov := FOUND;

  IF NOT v_has_cur AND NOT v_has_prov THEN
    -- Never seen: a tombstone is a no-op (never a blank insert).
    IF v_tomb THEN RETURN 'unknown_tombstone'; END IF;
    INSERT INTO public.referrals (
      id, created_at, deleted_at, status, referral_received_at, age, sex,
      current_ward, current_bed, referring_specialty, reason_category, ceiling_of_care,
      resus_status, dnacpr_respect, anticipated_interventions, allergies, weight_kg,
      admission_urgency, infection_status, news2_score)
    VALUES (
      v_id, v_row.created_at, NULL, v_row.status, v_row.referral_received_at, v_row.age, v_row.sex,
      v_row.current_ward, v_row.current_bed, v_row.referring_specialty, v_row.reason_category,
      v_row.ceiling_of_care, v_row.resus_status, v_row.dnacpr_respect, v_row.anticipated_interventions,
      v_row.allergies, v_row.weight_kg, v_row.admission_urgency, v_row.infection_status, v_row.news2_score)
    RETURNING * INTO v_cur;
    INSERT INTO private.bridge_referral_provenance (referral_id, source_revision, receiver_revision, source_deleted_at)
    VALUES (v_id, v_src_rev, v_cur.updated_at, NULL);
    v_before := NULL;
    v_after := private.referral_import_fields(v_cur);
    v_changed := ARRAY[]::text[];
    v_result := 'inserted';
  ELSIF NOT v_has_prov OR NOT v_has_cur THEN
    -- A local row we never imported (legacy copy, or created here), or
    -- provenance for a row that is gone: a person must decide. Never adopted.
    RETURN 'conflict';
  ELSIF v_src_rev <= v_prov.source_revision THEN
    -- Same or older source revision: replay / out-of-order delivery.
    RETURN 'unchanged';
  ELSIF v_cur.updated_at IS DISTINCT FROM v_prov.receiver_revision THEN
    -- Changed here since our last import: never overwritten.
    RETURN 'conflict';
  ELSE
    v_before := private.referral_import_fields(v_cur);
    IF v_tomb THEN
      UPDATE public.referrals r SET deleted_at = v_src_deleted
       WHERE r.id = v_id AND r.updated_at = v_prov.receiver_revision
      RETURNING * INTO v_cur;
      v_result := 'deleted';
    ELSE
      UPDATE public.referrals r SET
        deleted_at = NULL, status = v_row.status,
        referral_received_at = v_row.referral_received_at, age = v_row.age, sex = v_row.sex,
        current_ward = v_row.current_ward, current_bed = v_row.current_bed,
        referring_specialty = v_row.referring_specialty, reason_category = v_row.reason_category,
        ceiling_of_care = v_row.ceiling_of_care, resus_status = v_row.resus_status,
        dnacpr_respect = v_row.dnacpr_respect, anticipated_interventions = v_row.anticipated_interventions,
        allergies = v_row.allergies, weight_kg = v_row.weight_kg,
        admission_urgency = v_row.admission_urgency, infection_status = v_row.infection_status,
        news2_score = v_row.news2_score
       WHERE r.id = v_id AND r.updated_at = v_prov.receiver_revision
      RETURNING * INTO v_cur;
      v_result := CASE WHEN v_before ->> 'deleted_at' IS NOT NULL THEN 'restored' ELSE 'updated' END;
    END IF;
    IF NOT FOUND THEN RETURN 'conflict'; END IF;
    UPDATE private.bridge_referral_provenance p
       SET source_revision = v_src_rev, receiver_revision = v_cur.updated_at,
           source_deleted_at = v_src_deleted, last_imported_at = now()
     WHERE p.referral_id = v_id;
    v_after := private.referral_import_fields(v_cur);
    SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) INTO v_changed
      FROM jsonb_object_keys(v_after) k WHERE (v_before -> k) IS DISTINCT FROM (v_after -> k);
  END IF;

  -- Same transaction: if this fails, the content and provenance roll back too.
  INSERT INTO public.record_audit
    (entity, record_id, action, source, actor_id, actor_role, actor_email, changed_fields, before, after)
  VALUES ('referrals', v_id, CASE WHEN v_result = 'inserted' THEN 'insert' ELSE 'update' END, 'bridge',
          '00000000-0000-0000-0000-000000000000', 'inbound_sync', 'sync-bot@icu-handover', v_changed,
          v_before, v_after || jsonb_build_object('source_revision', v_src_rev, 'import_outcome', v_result));
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.bridge_import_referral(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_referral(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- New-id-only result import, linked to an EXISTING patient in the bridge
-- unit that is still shared. The patient row is held FOR SHARE until the
-- transaction ends, so a concurrent sharing revocation waits rather than
-- racing the insert. Returns 'inserted' | 'identical' | 'conflict' |
-- 'parent_unavailable'. Never creates or edits a patient; never overwrites.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_import_result(_kind text, _rec jsonb)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid;
  v_id uuid;
  v_pid uuid;
  v_type text := _rec ->> 'type';
  v_findings text := _rec ->> 'findings';
  v_result_at timestamptz;
  v_created timestamptz;
  v_updated timestamptz;
  v_e record;
BEGIN
  BEGIN
    v_id := (_rec ->> 'id')::uuid;
    v_pid := (_rec ->> 'patient_id')::uuid;
    v_result_at := (_rec ->> 'result_at')::timestamptz;
    v_created := (_rec ->> 'created_at')::timestamptz;
    v_updated := (_rec ->> 'updated_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
  END;
  IF _kind IS NULL OR _kind NOT IN ('investigations', 'microbiology')
     OR v_id IS NULL OR v_pid IS NULL OR v_result_at IS NULL OR v_created IS NULL OR v_updated IS NULL
     OR coalesce(btrim(v_type), '') = '' OR coalesce(btrim(v_findings), '') = '' THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
  END IF;
  v_unit := private.bridge_unit_id();

  PERFORM 1 FROM public.patients p
   WHERE p.id = v_pid AND p.unit_id = v_unit AND p.shared_with_partner
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'parent_unavailable';
  END IF;

  IF _kind = 'investigations' THEN
    INSERT INTO public.investigations (id, patient_id, category, findings, result_at, created_at, updated_at)
    VALUES (v_id, v_pid, v_type, v_findings, v_result_at, v_created, v_updated)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT i.patient_id, i.category AS kind_value, i.findings, i.result_at INTO v_e
        FROM public.investigations i WHERE i.id = v_id;
    END IF;
  ELSE
    INSERT INTO public.microbiology_results (id, patient_id, specimen_type, findings, result_at, created_at, updated_at)
    VALUES (v_id, v_pid, v_type, v_findings, v_result_at, v_created, v_updated)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT m.patient_id, m.specimen_type AS kind_value, m.findings, m.result_at INTO v_e
        FROM public.microbiology_results m WHERE m.id = v_id;
    END IF;
  END IF;
  IF v_e IS NOT NULL THEN
    IF v_e.patient_id = v_pid AND v_e.kind_value = v_type AND v_e.findings = v_findings
       AND v_e.result_at = v_result_at THEN
      RETURN 'identical';
    END IF;
    RETURN 'conflict';
  END IF;

  -- Same transaction as the insert.
  INSERT INTO public.record_audit
    (entity, record_id, action, source, actor_id, actor_role, actor_email, changed_fields, before, after)
  VALUES (_kind, v_id, 'insert', 'bridge',
          '00000000-0000-0000-0000-000000000000', 'inbound_sync', 'sync-bot@icu-handover', ARRAY[]::text[], NULL,
          jsonb_build_object('id', v_id, 'patient_id', v_pid,
            CASE WHEN _kind = 'investigations' THEN 'category' ELSE 'specimen_type' END, v_type,
            'findings', v_findings, 'result_at', v_result_at));
  RETURN 'inserted';
END
$$;
REVOKE ALL ON FUNCTION public.bridge_import_result(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_result(text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Existing signed partner investigation insert: bridge unit AND shared, in
-- the same locked statement. Same signature and return type as live.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_insert_investigation(
  _patient_id uuid, _category text, _findings text, _result_at timestamptz)
RETURNS SETOF public.investigations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid := private.bridge_unit_id();
BEGIN
  PERFORM 1 FROM public.patients p
   WHERE p.id = _patient_id AND p.unit_id = v_unit AND p.shared_with_partner
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    INSERT INTO public.investigations (patient_id, category, findings, result_at)
    VALUES (_patient_id, _category, _findings, coalesce(_result_at, now()))
    RETURNING *;
END
$$;
REVOKE ALL ON FUNCTION public.bridge_insert_investigation(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_insert_investigation(uuid, text, text, timestamptz) TO service_role;
