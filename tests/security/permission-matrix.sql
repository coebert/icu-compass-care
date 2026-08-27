-- Role permission matrix probe (see Critical_Care_Permission_Matrix_v1.docx).
--
-- Builds a throw-away multi-hospital / multi-unit fixture, then replays every
-- read and write the matrix describes as each role, recording whether the
-- database actually allowed it. Everything runs inside a single transaction
-- that is ROLLED BACK at the end, so no fixture data is ever committed.
--
-- Fixtures are created with session_replication_role = replica so that no rows
-- have to be written into the auth schema: foreign keys to auth.users are not
-- checked while seeding. Replication role is returned to 'origin' before any
-- permission probe runs, so the probes execute under normal constraints.
--
-- Output: one JSON array of { actor, scope, action, allowed, detail } rows.

BEGIN;

SET LOCAL client_min_messages = warning;

CREATE TEMP TABLE matrix_results (
  actor text,
  scope text,
  action text,
  allowed boolean,
  detail text
) ON COMMIT DROP;

DO $probe$
DECLARE
  orig_role text := current_user;

  h_own   uuid := gen_random_uuid();  -- hospital running the deployment
  h_other uuid := gen_random_uuid();  -- a different hospital (Option B only)
  u_own   uuid := gen_random_uuid();  -- own ICU
  u_sibling uuid := gen_random_uuid(); -- another ICU in the same hospital
  u_far   uuid := gen_random_uuid();  -- ICU in a different hospital

  clin_single uuid := gen_random_uuid(); -- clinician, membership of own unit only
  clin_multi  uuid := gen_random_uuid(); -- rotating clinician, own + far unit
  clin_other  uuid := gen_random_uuid(); -- clinician of the sibling unit
  administr   uuid := gen_random_uuid(); -- administrator (accounts + unit config)
  no_role     uuid := gen_random_uuid(); -- signed in, no clinical role granted

  p_own uuid := gen_random_uuid();
  p_sibling uuid := gen_random_uuid();
  p_far uuid := gen_random_uuid();

  cd_own uuid := gen_random_uuid();
  cd_sibling uuid := gen_random_uuid();
  cd_far uuid := gen_random_uuid();

  actor_label text;
  actor_id uuid;
  actor_role text;
  scope_label text;
  patient_id uuid;
  chart_id uuid;
  unit_id uuid;

  actors jsonb := jsonb_build_array(
    jsonb_build_object('label', 'clinician_single_unit', 'id', clin_single, 'db_role', 'authenticated'),
    jsonb_build_object('label', 'clinician_multi_unit', 'id', clin_multi, 'db_role', 'authenticated'),
    jsonb_build_object('label', 'clinician_other_unit', 'id', clin_other, 'db_role', 'authenticated'),
    jsonb_build_object('label', 'administrator', 'id', administr, 'db_role', 'authenticated'),
    jsonb_build_object('label', 'signed_in_no_role', 'id', no_role, 'db_role', 'authenticated'),
    jsonb_build_object('label', 'unauthenticated', 'id', NULL, 'db_role', 'anon')
  );

  scopes jsonb;
  actor jsonb;
  scope jsonb;

  n integer;
BEGIN
  -- ---------------------------------------------------------------- fixtures
  PERFORM set_config('session_replication_role', 'replica', true);

  INSERT INTO public.hospitals (id, name, code)
  VALUES (h_own, 'Matrix Test Hospital A', 'MTX-A'),
         (h_other, 'Matrix Test Hospital B', 'MTX-B');

  INSERT INTO public.icu_units (id, hospital_id, name, code)
  VALUES (u_own, h_own, 'Matrix Own ICU', 'MTX-A-OWN'),
         (u_sibling, h_own, 'Matrix Sibling ICU', 'MTX-A-SIB'),
         (u_far, h_other, 'Matrix Far ICU', 'MTX-B-FAR');

  INSERT INTO public.user_roles (user_id, role)
  VALUES (clin_single, 'clinician'),
         (clin_multi, 'clinician'),
         (clin_other, 'clinician'),
         (administr, 'admin');

  INSERT INTO public.user_unit_access (user_id, unit_id)
  VALUES (clin_single, u_own),
         (clin_multi, u_own),
         (clin_multi, u_far),
         (clin_other, u_sibling);

  INSERT INTO public.profiles (id, display_name)
  VALUES (clin_single, 'Matrix Clinician One'),
         (clin_multi, 'Matrix Clinician Multi'),
         (clin_other, 'Matrix Clinician Other'),
         (administr, 'Matrix Administrator'),
         (no_role, 'Matrix No Role');

  INSERT INTO public.patients (id, unit_id, full_name, hospital_number, location_type, status)
  VALUES (p_own, u_own, 'A.B.', 'MTX-OWN', 'icu', 'admitted'),
         (p_sibling, u_sibling, 'C.D.', 'MTX-SIB', 'icu', 'admitted'),
         (p_far, u_far, 'E.F.', 'MTX-FAR', 'icu', 'admitted');

  INSERT INTO public.patient_tasks (patient_id, description, status, position)
  VALUES (p_own, 'matrix task', 'not_started', 1),
         (p_sibling, 'matrix task', 'not_started', 1),
         (p_far, 'matrix task', 'not_started', 1);

  INSERT INTO public.chart_days (id, patient_id, chart_date, source)
  VALUES (cd_own, p_own, current_date, 'manual'),
         (cd_sibling, p_sibling, current_date, 'manual'),
         (cd_far, p_far, current_date, 'manual');

  INSERT INTO public.chart_hourly (chart_day_id, hour, hr)
  VALUES (cd_own, 7, 80), (cd_sibling, 7, 80), (cd_far, 7, 80);

  INSERT INTO public.investigations (patient_id, category, findings, result_at)
  VALUES (p_own, 'bloods', 'matrix', now()),
         (p_sibling, 'bloods', 'matrix', now()),
         (p_far, 'bloods', 'matrix', now());

  INSERT INTO public.microbiology_results (patient_id, specimen_type, findings, result_at)
  VALUES (p_own, 'sputum', 'matrix', now()),
         (p_sibling, 'sputum', 'matrix', now()),
         (p_far, 'sputum', 'matrix', now());

  INSERT INTO public.patient_field_changes (patient_id, field_name, old_value, new_value)
  VALUES (p_own, 'ward', 'a', 'b'),
         (p_sibling, 'ward', 'a', 'b'),
         (p_far, 'ward', 'a', 'b');

  PERFORM set_config('session_replication_role', 'origin', true);

  scopes := jsonb_build_array(
    jsonb_build_object('label', 'own_unit', 'patient', p_own, 'chart', cd_own, 'unit', u_own),
    jsonb_build_object('label', 'other_unit_same_hospital', 'patient', p_sibling, 'chart', cd_sibling, 'unit', u_sibling),
    jsonb_build_object('label', 'unit_in_other_hospital', 'patient', p_far, 'chart', cd_far, 'unit', u_far)
  );

  -- ------------------------------------------------------------------ probes
  FOR actor IN SELECT * FROM jsonb_array_elements(actors) LOOP
    actor_label := actor ->> 'label';
    actor_id := NULLIF(actor ->> 'id', '')::uuid;
    actor_role := actor ->> 'db_role';

    PERFORM set_config('role', actor_role, true);
    IF actor_id IS NULL THEN
      PERFORM set_config('request.jwt.claims', NULL, true);
    ELSE
      PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object('sub', actor_id::text, 'role', 'authenticated')::text,
        true
      );
    END IF;

    FOR scope IN SELECT * FROM jsonb_array_elements(scopes) LOOP
      scope_label := scope ->> 'label';
      patient_id := (scope ->> 'patient')::uuid;
      chart_id := (scope ->> 'chart')::uuid;
      unit_id := (scope ->> 'unit')::uuid;

      -- Patient clinical record: view / edit / create / remove
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.patients WHERE id = $1' INTO n USING patient_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'patient_view', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'patient_view', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'UPDATE public.patients SET ward = ''matrix'' WHERE id = $1' USING patient_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'patient_edit', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'patient_edit', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'INSERT INTO public.patients (unit_id, full_name, hospital_number, location_type, status)
                 VALUES ($1, ''X.Y.'', ''MTX-NEW'', ''icu'', ''admitted'')' USING unit_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'patient_create', true, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'patient_create', false, SQLERRM);
      END;

      -- Jobs list / tasks
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.patient_tasks WHERE patient_id = $1' INTO n USING patient_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'task_view', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'task_view', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'UPDATE public.patient_tasks SET status = ''in_progress'' WHERE patient_id = $1' USING patient_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'task_edit', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'task_edit', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'INSERT INTO public.patient_tasks (patient_id, description, status, position)
                 VALUES ($1, ''matrix new'', ''not_started'', 9)' USING patient_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'task_create', true, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'task_create', false, SQLERRM);
      END;

      -- Digitised 24h chart values
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.chart_hourly WHERE chart_day_id = $1' INTO n USING chart_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'chart_view', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'chart_view', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'UPDATE public.chart_hourly SET hr = 91 WHERE chart_day_id = $1' USING chart_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'chart_edit', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'chart_edit', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'DELETE FROM public.chart_days WHERE id = $1' USING chart_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'chart_delete', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'chart_delete', false, SQLERRM);
      END;

      -- Microbiology / antimicrobial timelines and investigations
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.microbiology_results WHERE patient_id = $1' INTO n USING patient_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'micro_view', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'micro_view', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'INSERT INTO public.investigations (patient_id, category, findings, result_at)
                 VALUES ($1, ''bloods'', ''matrix new'', now())' USING patient_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'investigation_create', true, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'investigation_create', false, SQLERRM);
      END;

      -- Edit history / attribution
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.patient_field_changes WHERE patient_id = $1' INTO n USING patient_id;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'edit_history_view', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'edit_history_view', false, SQLERRM);
      END;

      BEGIN
        EXECUTE 'DELETE FROM public.patient_field_changes WHERE patient_id = $1' USING patient_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'edit_history_delete', n > 0, NULL);
      EXCEPTION WHEN others THEN
        INSERT INTO matrix_results VALUES (actor_label, scope_label, 'edit_history_delete', false, SQLERRM);
      END;
    END LOOP;

    -- Configuration, accounts and audit surfaces (scope-independent)
    BEGIN
      EXECUTE 'INSERT INTO public.icu_units (hospital_id, name, code) VALUES ($1, ''Matrix New ICU'', ''MTX-NEW'')'
        USING h_own;
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'unit_config_edit', true, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'unit_config_edit', false, SQLERRM);
    END;

    BEGIN
      EXECUTE 'INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1, $2)'
        USING no_role, u_own;
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'grant_unit_access', true, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'grant_unit_access', false, SQLERRM);
    END;

    BEGIN
      EXECUTE 'INSERT INTO public.user_roles (user_id, role) VALUES ($1, ''clinician'')' USING no_role;
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'assign_role', true, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'assign_role', false, SQLERRM);
    END;

    BEGIN
      EXECUTE 'SELECT count(*) FROM public.user_roles WHERE user_id <> $1' INTO n USING COALESCE(actor_id, gen_random_uuid());
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'view_other_roles', n > 0, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'view_other_roles', false, SQLERRM);
    END;

    BEGIN
      EXECUTE 'SELECT count(*) FROM public.account_access_events' INTO n;
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'view_access_log', n >= 0, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'view_access_log', false, SQLERRM);
    END;

    BEGIN
      EXECUTE 'SELECT count(*) FROM public.profiles WHERE id = $1' INTO n USING no_role;
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'view_other_profile', n > 0, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'view_other_profile', false, SQLERRM);
    END;

    BEGIN
      EXECUTE 'SELECT count(*) FROM public.crypto_key_escrow' INTO n;
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'read_encryption_keys', true, NULL);
    EXCEPTION WHEN others THEN
      INSERT INTO matrix_results VALUES (actor_label, 'config', 'read_encryption_keys', false, SQLERRM);
    END;

    PERFORM set_config('role', orig_role, true);
    PERFORM set_config('request.jwt.claims', NULL, true);
  END LOOP;
END
$probe$;

SELECT coalesce(json_agg(json_build_object(
  'actor', actor, 'scope', scope, 'action', action, 'allowed', allowed, 'detail', detail
)), '[]'::json) AS results
FROM matrix_results;

ROLLBACK;
