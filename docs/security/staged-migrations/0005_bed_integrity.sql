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
--    The intended final operation is audited INSIDE the same transaction
--    (record_audit + patient_field_changes, actor taken from auth.uid()), so a
--    direct authenticated RPC call cannot skip the audit, and an audit failure
--    rolls back both halves of a swap. The transient cleared bed is never
--    recorded.
-- Depends on: drizzle 0002-0004 (private.session_active, can_edit_unit).
-- Followed by 0006 (bridge import provenance) and 0007 (wardable fence).
--
-- Non-destructive: no rows are changed or removed. The preflight aborts the
-- whole migration if existing data would violate the new rule; it never
-- tidies data itself.
-- =============================================================================

-- The trim set below uses non-ASCII whitespace characters.
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'bed preflight failed: database encoding must be UTF8. Nothing was changed.';
  END IF;
END $$;

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
  v_email text;
  v_changed text[];
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

  -- Audit the intended final operation only (never the transient cleared bed),
  -- in this transaction: if either audit insert fails, every change above
  -- rolls back with it.
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;
  FOR v_p IN
    SELECT p.id, p.bed, p.location_type::text AS loc, p.updated_at
    FROM public.patients p WHERE p.id = ANY (v_ids) ORDER BY p.id
  LOOP
    v_c := v_cur -> v_p.id::text;
    v_changed := ARRAY[]::text[];
    IF (v_c ->> 'bed') IS DISTINCT FROM v_p.bed THEN v_changed := array_append(v_changed, 'bed'); END IF;
    IF (v_c ->> 'loc') IS DISTINCT FROM v_p.loc THEN v_changed := array_append(v_changed, 'location_type'); END IF;
    INSERT INTO public.record_audit
      (entity, record_id, action, source, actor_id, actor_role, actor_email, changed_fields, before, after)
    VALUES ('patients', v_p.id, 'update', 'app', v_uid, NULL, v_email, v_changed,
            jsonb_build_object('bed', v_c -> 'bed', 'location_type', v_c -> 'loc'),
            jsonb_build_object('bed', v_p.bed, 'location_type', v_p.loc,
                               'operation', CASE WHEN v_n = 2 THEN 'swap' ELSE 'move' END));
    IF 'bed' = ANY (v_changed) THEN
      INSERT INTO public.patient_field_changes (patient_id, field_name, old_value, new_value, changed_by, changed_by_email)
      VALUES (v_p.id, 'bed', nullif(v_c ->> 'bed', ''), nullif(v_p.bed, ''), v_uid, v_email);
    END IF;
    IF 'location_type' = ANY (v_changed) THEN
      INSERT INTO public.patient_field_changes (patient_id, field_name, old_value, new_value, changed_by, changed_by_email)
      VALUES (v_p.id, 'location_type', v_c ->> 'loc', v_p.loc, v_uid, v_email);
    END IF;
  END LOOP;

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
