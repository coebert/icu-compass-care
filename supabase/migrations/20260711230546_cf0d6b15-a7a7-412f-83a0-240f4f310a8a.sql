-- Raw log of failed/suspicious bridge access attempts
CREATE TABLE public.bridge_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  endpoint text,
  method text,
  ip text,
  actor_role text,
  actor_email text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.bridge_security_events TO authenticated;
GRANT ALL ON public.bridge_security_events TO service_role;
ALTER TABLE public.bridge_security_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view bridge security events"
  ON public.bridge_security_events FOR SELECT TO authenticated
  USING (private.has_role(auth.uid(), 'admin'));
CREATE INDEX idx_bridge_security_events_created_at
  ON public.bridge_security_events (created_at DESC);
CREATE INDEX idx_bridge_security_events_type_time
  ON public.bridge_security_events (event_type, created_at DESC);

-- Deduplicated incidents raised when suspicious events cross a threshold
CREATE TABLE public.bridge_security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  alert_key text NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  window_minutes integer NOT NULL,
  threshold integer NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  sample_detail text,
  sample_ip text,
  sample_actor_email text,
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.bridge_security_alerts TO authenticated;
GRANT ALL ON public.bridge_security_alerts TO service_role;
ALTER TABLE public.bridge_security_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view bridge security alerts"
  ON public.bridge_security_alerts FOR SELECT TO authenticated
  USING (private.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins update bridge security alerts"
  ON public.bridge_security_alerts FOR UPDATE TO authenticated
  USING (private.has_role(auth.uid(), 'admin'))
  WITH CHECK (private.has_role(auth.uid(), 'admin'));
CREATE INDEX idx_bridge_security_alerts_status
  ON public.bridge_security_alerts (status, last_seen DESC);
-- At most one OPEN alert per grouping key; enables safe concurrent upserts.
CREATE UNIQUE INDEX uq_bridge_security_alerts_open_key
  ON public.bridge_security_alerts (alert_key) WHERE status = 'open';

CREATE TRIGGER trg_bridge_security_alerts_updated_at
  BEFORE UPDATE ON public.bridge_security_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Atomic: record one security event, then raise/update an alert when repeated
-- signature failures or replay detections exceed the threshold in the window.
CREATE OR REPLACE FUNCTION public.record_bridge_security_event(
  _event_type text,
  _endpoint text DEFAULT NULL,
  _method text DEFAULT NULL,
  _ip text DEFAULT NULL,
  _actor_role text DEFAULT NULL,
  _actor_email text DEFAULT NULL,
  _detail text DEFAULT NULL,
  _window_minutes integer DEFAULT 10,
  _threshold integer DEFAULT 5
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _recent integer;
BEGIN
  INSERT INTO public.bridge_security_events(
    event_type, endpoint, method, ip, actor_role, actor_email, detail
  ) VALUES (
    _event_type, _endpoint, _method, _ip, _actor_role, _actor_email, _detail
  );

  -- Only these categories are treated as suspicious for alerting.
  IF _event_type NOT IN ('signature_failure', 'replay_detected') THEN
    RETURN;
  END IF;

  SELECT count(*) INTO _recent
  FROM public.bridge_security_events
  WHERE event_type = _event_type
    AND created_at > now() - make_interval(mins => _window_minutes);

  IF _recent < _threshold THEN
    RETURN;
  END IF;

  UPDATE public.bridge_security_alerts
     SET event_count = _recent,
         last_seen = now(),
         sample_detail = COALESCE(_detail, sample_detail),
         sample_ip = COALESCE(_ip, sample_ip),
         sample_actor_email = COALESCE(_actor_email, sample_actor_email)
   WHERE alert_key = _event_type AND status = 'open';

  IF NOT FOUND THEN
    INSERT INTO public.bridge_security_alerts(
      event_type, alert_key, event_count, window_minutes, threshold,
      sample_detail, sample_ip, sample_actor_email
    ) VALUES (
      _event_type, _event_type, _recent, _window_minutes, _threshold,
      _detail, _ip, _actor_email
    )
    ON CONFLICT (alert_key) WHERE status = 'open' DO UPDATE
      SET event_count = EXCLUDED.event_count, last_seen = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_bridge_security_event(text,text,text,text,text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_bridge_security_event(text,text,text,text,text,text,text,integer,integer) TO service_role;