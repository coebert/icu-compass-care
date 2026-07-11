CREATE TABLE public.bridge_rate_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.bridge_rate_limits TO service_role;
ALTER TABLE public.bridge_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_bridge_rate_limits_updated_at
  ON public.bridge_rate_limits (updated_at);

CREATE OR REPLACE FUNCTION public.check_bridge_rate_limit(
  _bucket_key text,
  _limit integer,
  _window_seconds integer DEFAULT 60
) RETURNS TABLE(allowed boolean, current_count integer, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.bridge_rate_limits%ROWTYPE;
  _now timestamptz := now();
BEGIN
  DELETE FROM public.bridge_rate_limits
    WHERE updated_at < _now - interval '1 day';

  INSERT INTO public.bridge_rate_limits(bucket_key, window_start, count)
    VALUES (_bucket_key, _now, 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET count = CASE
          WHEN public.bridge_rate_limits.window_start < _now - make_interval(secs => _window_seconds)
          THEN 1
          ELSE public.bridge_rate_limits.count + 1
        END,
        window_start = CASE
          WHEN public.bridge_rate_limits.window_start < _now - make_interval(secs => _window_seconds)
          THEN _now
          ELSE public.bridge_rate_limits.window_start
        END,
        updated_at = _now
  RETURNING * INTO _row;

  RETURN QUERY SELECT
    (_row.count <= _limit),
    _row.count,
    GREATEST(0, _window_seconds - EXTRACT(EPOCH FROM (_now - _row.window_start))::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.check_bridge_rate_limit(text,integer,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_bridge_rate_limit(text,integer,integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_bridge_rate_limit(text,integer,integer) TO service_role;

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

  IF _event_type NOT IN ('signature_failure', 'replay_detected', 'rate_limited') THEN
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
REVOKE EXECUTE ON FUNCTION public.record_bridge_security_event(text,text,text,text,text,text,text,integer,integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bridge_security_event(text,text,text,text,text,text,text,integer,integer) TO service_role;