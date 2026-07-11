CREATE TABLE public.handover_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  local_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('am','pm')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  label text NOT NULL,
  patient_count integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL,
  search_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (local_date, shift)
);

GRANT SELECT ON public.handover_versions TO authenticated;
GRANT ALL ON public.handover_versions TO service_role;

ALTER TABLE public.handover_versions ENABLE ROW LEVEL SECURITY;

-- Shared clinical team: any signed-in staff member can read all saved versions.
-- Writes happen only via the service role (scheduled snapshot / admin capture),
-- so no INSERT/UPDATE/DELETE policy is granted to authenticated users.
CREATE POLICY "Signed-in staff can read handover versions"
  ON public.handover_versions
  FOR SELECT
  TO authenticated
  USING (true);

-- Fast lookups for the history browser.
CREATE INDEX handover_versions_local_date_idx
  ON public.handover_versions (local_date DESC, shift);