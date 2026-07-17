
CREATE TYPE public.chart_source AS ENUM ('scan', 'manual');

CREATE TABLE public.chart_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  chart_date date NOT NULL,
  source public.chart_source NOT NULL DEFAULT 'manual',
  notes text,
  balance_24h_ml integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, chart_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chart_days TO authenticated;
GRANT ALL ON public.chart_days TO service_role;
ALTER TABLE public.chart_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read chart_days" ON public.chart_days FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert chart_days" ON public.chart_days FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update chart_days" ON public.chart_days FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete chart_days" ON public.chart_days FOR DELETE TO authenticated USING (true);
CREATE TRIGGER trg_chart_days_updated_at BEFORE UPDATE ON public.chart_days FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.chart_hourly (
  chart_day_id uuid NOT NULL REFERENCES public.chart_days(id) ON DELETE CASCADE,
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  -- Fluid intake / output
  intake_ml integer,
  flushes_ml integer,
  ng_aspirate_ml integer,
  ng_free_ml integer,
  urine_ml integer,
  bowels text,
  target_removal_ml integer,
  actual_removal_ml integer,
  hourly_balance_ml integer,
  cumulative_balance_ml integer,
  -- Vitals
  hr integer,
  sbp integer,
  dbp integer,
  map integer,
  cvp integer,
  spo2 integer,
  etco2 integer,
  rr integer,
  temp numeric(4,1),
  gcs integer,
  cam_icu text,
  pupils_l text,
  pupils_r text,
  -- Ventilation
  vent_mode text,
  peep integer,
  fio2 numeric(4,2),
  p_support integer,
  tv integer,
  mv numeric(5,2),
  peak_pressure integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chart_day_id, hour)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chart_hourly TO authenticated;
GRANT ALL ON public.chart_hourly TO service_role;
ALTER TABLE public.chart_hourly ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read chart_hourly" ON public.chart_hourly FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert chart_hourly" ON public.chart_hourly FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update chart_hourly" ON public.chart_hourly FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete chart_hourly" ON public.chart_hourly FOR DELETE TO authenticated USING (true);
CREATE TRIGGER trg_chart_hourly_updated_at BEFORE UPDATE ON public.chart_hourly FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_chart_days_patient_date ON public.chart_days(patient_id, chart_date DESC);
CREATE INDEX idx_chart_hourly_day ON public.chart_hourly(chart_day_id);
