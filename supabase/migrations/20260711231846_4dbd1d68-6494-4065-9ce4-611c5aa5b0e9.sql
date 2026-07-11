CREATE TABLE public.bridge_lockouts (
  ip text PRIMARY KEY,
  strikes integer NOT NULL DEFAULT 0,
  first_strike_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.bridge_lockouts TO service_role;
ALTER TABLE public.bridge_lockouts ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_bridge_lockouts_updated_at ON public.bridge_lockouts (updated_at);
CREATE INDEX idx_bridge_lockouts_locked_until ON public.bridge_lockouts (locked_until);

-- Is this IP currently locked out? Returns whether locked and seconds remaining.
CREATE OR REPLACE FUNCTION public.check_bridge_lockout(_ip text)
RETURNS TABLE(locked boolean, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _until timestamptz;
  _now timestamptz := now();
BEGIN
  -- Opportunistic prune of stale, expired rows keeps the table bounded.
  DELETE FROM public.bridge_lockouts
    WHERE updated_at < _now - interval '1 day'
      AND (locked_until IS NULL OR locked_until < _now);

  IF _ip IS NULL THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  SELECT locked_until INTO _until FROM public.bridge_lockouts WHERE ip = _ip;

  IF _until IS NOT NULL AND _until > _now THEN
    RETURN QUERY SELECT true, GREATEST(1, EXTRACT(EPOCH FROM (_until - _now))::integer);
  ELSE
    RETURN QUERY SELECT false, 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_bridge_lockout(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_bridge_lockout(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_bridge_lockout(text) TO service_role;

-- Record one abuse strike for an IP. Strikes accumulate within a rolling window;
-- once they reach the threshold the IP is locked for an escalating cooldown
-- (base doubles per extra strike, capped at max). Returns whether now locked
-- and the cooldown seconds.
CREATE OR REPLACE FUNCTION public.register_bridge_strike(
  _ip text,
  _reason text DEFAULT NULL,
  _window_seconds integer DEFAULT 900,
  _threshold integer DEFAULT 5,
  _base_lock_seconds integer DEFAULT 300,
  _max_lock_seconds integer DEFAULT 3600
) RETURNS TABLE(locked boolean, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.bridge_lockouts%ROWTYPE;
  _now timestamptz := now();
  _lock_seconds integer;
  _until timestamptz;
BEGIN
  IF _ip IS NULL THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  INSERT INTO public.bridge_lockouts(ip, strikes, first_strike_at, last_reason)
    VALUES (_ip, 1, _now, _reason)
  ON CONFLICT (ip) DO UPDATE
    SET strikes = CASE
          WHEN public.bridge_lockouts.first_strike_at < _now - make_interval(secs => _window_seconds)
          THEN 1
          ELSE public.bridge_lockouts.strikes + 1
        END,
        first_strike_at = CASE
          WHEN public.bridge_lockouts.first_strike_at < _now - make_interval(secs => _window_seconds)
          THEN _now
          ELSE public.bridge_lockouts.first_strike_at
        END,
        last_reason = _reason,
        updated_at = _now
  RETURNING * INTO _row;

  IF _row.strikes >= _threshold THEN
    _lock_seconds := LEAST(
      _max_lock_seconds,
      _base_lock_seconds * (2 ^ LEAST(_row.strikes - _threshold, 20))::integer
    );
    _until := _now + make_interval(secs => _lock_seconds);
    UPDATE public.bridge_lockouts
       SET locked_until = _until, updated_at = _now
     WHERE ip = _ip;
    RETURN QUERY SELECT true, _lock_seconds;
  ELSE
    RETURN QUERY SELECT false, 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.register_bridge_strike(text,text,integer,integer,integer,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_bridge_strike(text,text,integer,integer,integer,integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_bridge_strike(text,text,integer,integer,integer,integer) TO service_role;