ALTER TABLE public.chart_days
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS idx_chart_days_patient_archived
  ON public.chart_days (patient_id, archived_at);

-- Replace delete policy with a hard block: charts must be archived, not deleted.
DROP POLICY IF EXISTS "Authenticated can delete chart_days" ON public.chart_days;
CREATE POLICY "No one can delete chart_days"
  ON public.chart_days FOR DELETE
  TO authenticated
  USING (false);

-- Corresponding block on hourly rows (cascade would still work via day archive, but the rows themselves must not be individually purged).
DROP POLICY IF EXISTS "Authenticated can delete chart_hourly" ON public.chart_hourly;
CREATE POLICY "No one can delete chart_hourly"
  ON public.chart_hourly FOR DELETE
  TO authenticated
  USING (false);
