REVOKE ALL ON public.bridge_rate_limits FROM anon, authenticated;
REVOKE ALL ON public.bridge_lockouts FROM anon, authenticated;
REVOKE ALL ON public.bridge_write_nonces FROM anon, authenticated;
GRANT ALL ON public.bridge_rate_limits TO service_role;
GRANT ALL ON public.bridge_lockouts TO service_role;
GRANT ALL ON public.bridge_write_nonces TO service_role;
COMMENT ON TABLE public.bridge_rate_limits IS 'Internal bridge throttling state. Service-role only: RLS enabled with no policies and no anon/authenticated grants (fail-closed).';
COMMENT ON TABLE public.bridge_lockouts IS 'Internal bridge lockout state. Service-role only: RLS enabled with no policies and no anon/authenticated grants (fail-closed).';
COMMENT ON TABLE public.bridge_write_nonces IS 'Internal bridge replay-protection nonces. Service-role only: RLS enabled with no policies and no anon/authenticated grants (fail-closed).';