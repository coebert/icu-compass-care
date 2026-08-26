-- Helper: derive initials (max 3, dot-separated) from any free-text name.
CREATE OR REPLACE FUNCTION public.to_initials(_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    (
      SELECT string_agg(upper(left(w, 1)), '.' ORDER BY ord)
      FROM (
        SELECT w, ord
        FROM regexp_split_to_table(
               btrim(regexp_replace(COALESCE(_name, ''), '[^A-Za-z]+', ' ', 'g')),
               '\s+'
             ) WITH ORDINALITY AS t(w, ord)
        WHERE w <> ''
        ORDER BY ord
        LIMIT 3
      ) s
    ),
    ''
  );
$$;

GRANT EXECUTE ON FUNCTION public.to_initials(text) TO authenticated, service_role;

-- Replace any stored full name with initials only.
UPDATE public.patients
SET full_name = COALESCE(public.to_initials(full_name), 'X')
WHERE char_length(btrim(full_name)) > 10
   OR full_name ~ '[A-Za-z]{4,}';

-- Hard rule: initials only from now on.
ALTER TABLE public.patients
  ADD CONSTRAINT patients_full_name_initials_only
  CHECK (
    char_length(btrim(full_name)) BETWEEN 1 AND 10
    AND full_name !~ '[A-Za-z]{4,}'
  );

COMMENT ON COLUMN public.patients.full_name IS
  'Patient INITIALS ONLY (e.g. "J.S."). Full names must never be stored here; enforced by patients_full_name_initials_only.';