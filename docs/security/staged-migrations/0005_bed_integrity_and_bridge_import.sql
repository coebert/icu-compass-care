-- =============================================================================
-- STAGED — NOT APPLIED. Do not copy into drizzle/migrations or run until the
-- coordinated release gate authorises it (see docs/security/deployment-sequencing.md).
--
-- 1. One active patient per bed per unit, enforced by the database for every
--    write path (app, partner bridge, direct API), using the same bed
--    normalisation as the app's normalizeBed(): JS String.trim() whitespace
--    removed from both ends, then upper-case. No prefix stripping, no padding.
-- 2. public.move_patient_beds(jsonb): one atomic, revision-checked move or
--    pair swap (also used for undo).
-- 3. Partner import helpers for the sync v1 contract:
--    public.bridge_import_referral / public.bridge_import_result, and a
--    referrals-only updated_at trigger that can keep the SOURCE revision.
--
-- Non-destructive: no rows are changed or removed. The preflight aborts the
-- whole migration if existing data would violate the new rule; it never
-- tidies data itself.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Bed normalisation (must match src/lib/icu-beds.ts normalizeBed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.normalize_bed(_bed text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT upper(btrim(
    coalesce(_bed, ''),
    -- ECMAScript WhiteSpace + LineTerminator (String.prototype.trim)
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) ||
    chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
    chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) ||
    chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)
  ))
$$;
REVOKE ALL ON FUNCTION private.normalize_bed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.normalize_bed(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Preflight: refuse to continue if any unit already has two active patients
-- in the same (normalised) bed, or an active bed holder without a unit.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dupes int;
  v_no_unit int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1
    FROM public.patients
    WHERE location_type = 'icu'::public.patient_location
      AND status IN ('admitted'::public.patient_status, 'referred'::public.patient_status)
      AND private.normalize_bed(bed) <> ''
    GROUP BY unit_id, private.normalize_bed(bed)
    HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO v_no_unit
  FROM public.patients
  WHERE location_type = 'icu'::public.patient_location
    AND status IN ('admitted'::public.patient_status, 'referred'::public.patient_status)
    AND private.normalize_bed(bed) <> ''
    AND unit_id IS NULL;
  IF v_dupes > 0 OR v_no_unit > 0 THEN
    RAISE EXCEPTION
      'bed preflight failed: % duplicate active bed group(s), % active bed holder(s) without a unit. Nothing was changed; resolve these records manually first.',
      v_dupes, v_no_unit;
  END IF;
END $$;

-- A regular partial unique index (not deferrable). Swaps stay possible
-- because move_patient_beds clears one bed before reassigning it, inside one
-- transaction.
CREATE UNIQUE INDEX IF NOT EXISTS patients_active_unit_bed_uniq
  ON public.patients (unit_id, private.normalize_bed(bed))
  WHERE location_type = 'icu'::public.patient_location
    AND status IN ('admitted'::public.patient_status, 'referred'::public.patient_status)
    AND private.normalize_bed(bed) <> '';

-- ---------------------------------------------------------------------------
-- Atomic move / swap / undo
-- _moves: [{ id, expected_updated_at, location_type: 'icu'|'outlier', bed }]
--   1 entry  = move (or unassign with bed null, or undo back to an outlier)
--   2 entries = exact swap of two ICU beds in the same unit
-- Errors (PostgREST status from SQLSTATE):
--   PT403 not_authorised  PT400 invalid_request / not_a_swap / no_change
--   PT404 not_found       PT409 conflict / bed_occupied
--   PT422 not_eligible / unknown_bed / isolation_side_room_only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_patient_beds(_moves jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n int;
  v_ids uuid[];
  v_m jsonb;
  v_p record;
  v_cur jsonb := '{}'::jsonb;
  v_c jsonb;
  v_unit uuid;
  v_roster_empty boolean;
  v_key text;
  v_known boolean;
  v_side boolean;
  v_a jsonb;
  v_b jsonb;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL OR NOT private.session_active() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = 'PT403';
  END IF;
  IF _moves IS NULL OR jsonb_typeof(_moves) <> 'array' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;
  v_n := jsonb_array_length(_moves);
  IF v_n < 1 OR v_n > 2 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;

  -- Shape: no client-supplied actor, unit or status; bounded printable labels.
  FOR v_m IN SELECT value FROM jsonb_array_elements(_moves) LOOP
    IF jsonb_typeof(v_m) <> 'object'
       OR coalesce(jsonb_typeof(v_m -> 'id'), '') <> 'string'
       OR NOT ((v_m ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR coalesce(jsonb_typeof(v_m -> 'expected_updated_at'), '') <> 'string'
       OR length(v_m ->> 'expected_updated_at') > 64
       OR coalesce(v_m ->> 'location_type', '') NOT IN ('icu', 'outlier')
       OR coalesce(jsonb_typeof(v_m -> 'bed'), 'missing') NOT IN ('string', 'null')
       OR length(coalesce(v_m ->> 'bed', '')) > 50
       OR coalesce(v_m ->> 'bed', '') ~ '[^ -~]'
    THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
    END IF;
    BEGIN
      PERFORM (v_m ->> 'expected_updated_at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
    END;
  END LOOP;

  SELECT array_agg(DISTINCT lower(e ->> 'id')::uuid ORDER BY lower(e ->> 'id')::uuid)
    INTO v_ids FROM jsonb_array_elements(_moves) e;
  IF cardinality(v_ids) <> v_n THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;

  -- Lock in a fixed order (by id) so two concurrent swaps can't deadlock.
  -- Rows outside the caller's editable units are simply not found.
  FOR v_p IN
    SELECT p.id, p.unit_id, p.bed, p.location_type::text AS loc, p.status::text AS status,
           p.isolation_required, p.updated_at
    FROM public.patients p
    WHERE p.id = ANY (v_ids) AND private.can_edit_unit(v_uid, p.unit_id)
    ORDER BY p.id
    FOR UPDATE
  LOOP
    v_cur := v_cur || jsonb_build_object(v_p.id::text, jsonb_build_object(
      'unit_id', v_p.unit_id, 'bed', v_p.bed, 'loc', v_p.loc, 'status', v_p.status,
      'iso', v_p.isolation_required, 'updated_at', v_p.updated_at));
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(v_cur)) <> v_n THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'PT404';
  END IF;
  IF (SELECT count(DISTINCT value ->> 'unit_id') FROM jsonb_each(v_cur)) <> 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'PT400';
  END IF;
  SELECT (value ->> 'unit_id')::uuid INTO v_unit FROM jsonb_each(v_cur) LIMIT 1;

  -- Every involved row must still be the revision the caller saw.
  FOR v_m IN SELECT value FROM jsonb_array_elements(_moves) LOOP
    v_c := v_cur -> lower(v_m ->> 'id');
    IF (v_c ->> 'updated_at')::timestamptz IS DISTINCT FROM (v_m ->> 'expected_updated_at')::timestamptz THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;

  v_roster_empty := NOT EXISTS (SELECT 1 FROM public.icu_beds);

  -- Eligibility for every ICU bed target.
  FOR v_m IN SELECT value FROM jsonb_array_elements(_moves) LOOP
    v_c := v_cur -> lower(v_m ->> 'id');
    v_key := private.normalize_bed(v_m ->> 'bed');
    IF (v_m ->> 'location_type') = 'icu' AND v_key <> '' THEN
      IF (v_c ->> 'status') NOT IN ('admitted', 'referred') THEN
        RAISE EXCEPTION 'not_eligible' USING ERRCODE = 'PT422';
      END IF;
      -- Roster has no unit column today: it is the bridge unit's roster. The
      -- default roster applies only when the table is genuinely empty.
      SELECT count(*) > 0, coalesce(bool_or(r.side), false) INTO v_known, v_side
      FROM (
        SELECT private.normalize_bed(b.label) AS k, b.is_side_room AS side FROM public.icu_beds b
        UNION ALL
        SELECT g::text, g IN (1, 2, 11, 12) FROM generate_series(1, 12) g WHERE v_roster_empty
      ) r
      WHERE r.k = v_key;
      IF NOT v_known THEN
        RAISE EXCEPTION 'unknown_bed' USING ERRCODE = 'PT422';
      END IF;
      IF (v_c ->> 'iso')::boolean AND NOT v_side THEN
        RAISE EXCEPTION 'isolation_side_room_only' USING ERRCODE = 'PT422';
      END IF;
    END IF;
    IF v_n = 1
       AND (v_m ->> 'location_type') = (v_c ->> 'loc')
       AND v_key = private.normalize_bed(v_c ->> 'bed') THEN
      RAISE EXCEPTION 'no_change' USING ERRCODE = 'PT400';
    END IF;
  END LOOP;

  IF v_n = 2 THEN
    v_a := _moves -> 0;
    v_b := _moves -> 1;
    -- Exactly an exchange of two ICU beds; nothing else may ride along.
    IF (v_a ->> 'location_type') <> 'icu' OR (v_b ->> 'location_type') <> 'icu'
       OR (v_cur -> lower(v_a ->> 'id') ->> 'loc') <> 'icu'
       OR (v_cur -> lower(v_b ->> 'id') ->> 'loc') <> 'icu'
       OR private.normalize_bed(v_a ->> 'bed') = ''
       OR private.normalize_bed(v_b ->> 'bed') = ''
       OR private.normalize_bed(v_a ->> 'bed') <> private.normalize_bed(v_cur -> lower(v_b ->> 'id') ->> 'bed')
       OR private.normalize_bed(v_b ->> 'bed') <> private.normalize_bed(v_cur -> lower(v_a ->> 'id') ->> 'bed')
    THEN
      RAISE EXCEPTION 'not_a_swap' USING ERRCODE = 'PT400';
    END IF;
  ELSE
    v_a := _moves -> 0;
    v_key := private.normalize_bed(v_a ->> 'bed');
    IF (v_a ->> 'location_type') = 'icu' AND v_key <> '' AND EXISTS (
      SELECT 1 FROM public.patients q
      WHERE q.unit_id = v_unit
        AND q.id <> lower(v_a ->> 'id')::uuid
        AND q.location_type = 'icu'::public.patient_location
        AND q.status IN ('admitted'::public.patient_status, 'referred'::public.patient_status)
        AND private.normalize_bed(q.bed) = v_key
    ) THEN
      RAISE EXCEPTION 'bed_occupied' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  BEGIN
    IF v_n = 1 THEN
      UPDATE public.patients
         SET bed = nullif(btrim(v_a ->> 'bed'), ''),
             location_type = (v_a ->> 'location_type')::public.patient_location,
             updated_by = v_uid
       WHERE id = lower(v_a ->> 'id')::uuid;
    ELSE
      -- Clear, then assign, then assign: never two holders of one bed, and
      -- the temporary empty position never outlives this transaction.
      UPDATE public.patients SET bed = NULL WHERE id = lower(v_a ->> 'id')::uuid;
      UPDATE public.patients SET bed = btrim(v_b ->> 'bed'), updated_by = v_uid
       WHERE id = lower(v_b ->> 'id')::uuid;
      UPDATE public.patients SET bed = btrim(v_a ->> 'bed'), updated_by = v_uid
       WHERE id = lower(v_a ->> 'id')::uuid;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Someone filled the target bed concurrently. Everything above rolls back.
    RAISE EXCEPTION 'bed_occupied' USING ERRCODE = 'PT409';
  END;

  -- Final positions only (the intended operation), for the caller's audit.
  SELECT jsonb_agg(jsonb_build_object(
           'id', p.id,
           'bed', p.bed,
           'location_type', p.location_type,
           'updated_at', p.updated_at,
           'previous_bed', v_cur -> p.id::text -> 'bed',
           'previous_location_type', v_cur -> p.id::text -> 'loc',
           'previous_updated_at', v_cur -> p.id::text -> 'updated_at'
         ) ORDER BY p.id)
    INTO v_out
  FROM public.patients p
  WHERE p.id = ANY (v_ids);
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.move_patient_beds(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_patient_beds(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Referrals: keep the SOURCE revision on bridge imports only.
-- Replaces only the referrals updated_at trigger; patients and every other
-- table keep update_updated_at_column() unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.referrals_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Set (transaction-local) only inside public.bridge_import_referral, and
  -- only honoured when the source revision moves forward.
  IF coalesce(current_setting('app.bridge_source_revision', true), '') = 'on'
     AND NEW.updated_at > OLD.updated_at THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE OR REPLACE TRIGGER referrals_set_updated_at
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION private.referrals_touch_updated_at();

-- Allowlisted referral import with compare-and-set on the local revision.
-- _expected_updated_at NULL = "expect no local row" (insert only).
-- Returns 'inserted' | 'updated' | 'unchanged' | 'conflict'.
CREATE OR REPLACE FUNCTION public.bridge_import_referral(_rec jsonb, _expected_updated_at timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_clean jsonb;
  v_row public.referrals;
  v_cur timestamptz;
BEGIN
  -- Explicit allowlist: *_enc, *_hash, created_by/updated_by/deleted_by,
  -- origin_booking_id and previous_referral_id can never be written here.
  v_clean := jsonb_build_object(
    'id', _rec -> 'id', 'created_at', _rec -> 'created_at', 'updated_at', _rec -> 'updated_at',
    'deleted_at', _rec -> 'deleted_at', 'status', _rec -> 'status',
    'referral_received_at', _rec -> 'referral_received_at', 'age', _rec -> 'age', 'sex', _rec -> 'sex',
    'current_ward', _rec -> 'current_ward', 'current_bed', _rec -> 'current_bed',
    'referring_specialty', _rec -> 'referring_specialty', 'reason_category', _rec -> 'reason_category',
    'ceiling_of_care', _rec -> 'ceiling_of_care', 'resus_status', _rec -> 'resus_status',
    'dnacpr_respect', _rec -> 'dnacpr_respect',
    'anticipated_interventions', coalesce(_rec -> 'anticipated_interventions', '[]'::jsonb),
    'allergies', _rec -> 'allergies', 'weight_kg', _rec -> 'weight_kg',
    'admission_urgency', _rec -> 'admission_urgency', 'infection_status', _rec -> 'infection_status',
    'news2_score', _rec -> 'news2_score');
  v_row := jsonb_populate_record(NULL::public.referrals, v_clean);
  IF v_row.id IS NULL OR v_row.updated_at IS NULL OR v_row.created_at IS NULL
     OR v_row.status IS NULL OR v_row.referral_received_at IS NULL OR v_row.dnacpr_respect IS NULL THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
  END IF;

  IF _expected_updated_at IS NULL THEN
    INSERT INTO public.referrals (
      id, created_at, updated_at, deleted_at, status, referral_received_at, age, sex,
      current_ward, current_bed, referring_specialty, reason_category, ceiling_of_care,
      resus_status, dnacpr_respect, anticipated_interventions, allergies, weight_kg,
      admission_urgency, infection_status, news2_score)
    VALUES (
      v_row.id, v_row.created_at, v_row.updated_at, v_row.deleted_at, v_row.status,
      v_row.referral_received_at, v_row.age, v_row.sex, v_row.current_ward, v_row.current_bed,
      v_row.referring_specialty, v_row.reason_category, v_row.ceiling_of_care, v_row.resus_status,
      v_row.dnacpr_respect, v_row.anticipated_interventions, v_row.allergies, v_row.weight_kg,
      v_row.admission_urgency, v_row.infection_status, v_row.news2_score)
    ON CONFLICT (id) DO NOTHING;
    IF FOUND THEN RETURN 'inserted'; END IF;
    RETURN 'conflict';
  END IF;

  SELECT r.updated_at INTO v_cur FROM public.referrals r WHERE r.id = v_row.id FOR UPDATE;
  IF NOT FOUND OR v_cur IS DISTINCT FROM _expected_updated_at THEN
    RETURN 'conflict';
  END IF;
  IF v_row.updated_at <= v_cur THEN
    RETURN 'unchanged';
  END IF;
  PERFORM set_config('app.bridge_source_revision', 'on', true);
  UPDATE public.referrals SET
    deleted_at = v_row.deleted_at, status = v_row.status,
    referral_received_at = v_row.referral_received_at, age = v_row.age, sex = v_row.sex,
    current_ward = v_row.current_ward, current_bed = v_row.current_bed,
    referring_specialty = v_row.referring_specialty, reason_category = v_row.reason_category,
    ceiling_of_care = v_row.ceiling_of_care, resus_status = v_row.resus_status,
    dnacpr_respect = v_row.dnacpr_respect, anticipated_interventions = v_row.anticipated_interventions,
    allergies = v_row.allergies, weight_kg = v_row.weight_kg,
    admission_urgency = v_row.admission_urgency, infection_status = v_row.infection_status,
    news2_score = v_row.news2_score,
    updated_at = v_row.updated_at
  WHERE id = v_row.id;
  PERFORM set_config('app.bridge_source_revision', 'off', true);
  RETURN 'updated';
END
$$;
REVOKE ALL ON FUNCTION public.bridge_import_referral(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_referral(jsonb, timestamptz) TO service_role;

-- New-id-only result import, linked to an EXISTING patient that is in the
-- bridge unit and still shared. The patient row is held FOR SHARE until the
-- transaction ends, so a concurrent sharing revocation waits rather than
-- racing the insert. Returns 'inserted' | 'identical' | 'conflict' |
-- 'parent_unavailable'. Never creates or edits a patient; never overwrites.
CREATE OR REPLACE FUNCTION public.bridge_import_result(_kind text, _rec jsonb, _unit_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
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
  IF _kind NOT IN ('investigations', 'microbiology') OR _unit_id IS NULL
     OR v_id IS NULL OR v_pid IS NULL OR v_result_at IS NULL OR v_created IS NULL OR v_updated IS NULL
     OR coalesce(btrim(v_type), '') = '' OR coalesce(btrim(v_findings), '') = '' THEN
    RAISE EXCEPTION 'invalid_record' USING ERRCODE = 'PT400';
  END IF;

  PERFORM 1 FROM public.patients p
   WHERE p.id = v_pid AND p.unit_id = _unit_id AND p.shared_with_partner
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'parent_unavailable';
  END IF;

  IF _kind = 'investigations' THEN
    INSERT INTO public.investigations (id, patient_id, category, findings, result_at, created_at, updated_at)
    VALUES (v_id, v_pid, v_type, v_findings, v_result_at, v_created, v_updated)
    ON CONFLICT (id) DO NOTHING;
    IF FOUND THEN RETURN 'inserted'; END IF;
    SELECT i.patient_id, i.category AS kind_value, i.findings, i.result_at INTO v_e
      FROM public.investigations i WHERE i.id = v_id;
  ELSE
    INSERT INTO public.microbiology_results (id, patient_id, specimen_type, findings, result_at, created_at, updated_at)
    VALUES (v_id, v_pid, v_type, v_findings, v_result_at, v_created, v_updated)
    ON CONFLICT (id) DO NOTHING;
    IF FOUND THEN RETURN 'inserted'; END IF;
    SELECT m.patient_id, m.specimen_type AS kind_value, m.findings, m.result_at INTO v_e
      FROM public.microbiology_results m WHERE m.id = v_id;
  END IF;
  IF v_e.patient_id = v_pid AND v_e.kind_value = v_type AND v_e.findings = v_findings
     AND v_e.result_at = v_result_at THEN
    RETURN 'identical';
  END IF;
  RETURN 'conflict';
END
$$;
REVOKE ALL ON FUNCTION public.bridge_import_result(text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_result(text, jsonb, uuid) TO service_role;
