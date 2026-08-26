REVOKE ALL ON public.crypto_key_escrow FROM anon, authenticated;
GRANT ALL ON public.crypto_key_escrow TO service_role;
REVOKE ALL ON public.bridge_lockouts FROM anon, authenticated;
REVOKE ALL ON public.bridge_rate_limits FROM anon, authenticated;
REVOKE ALL ON public.bridge_write_nonces FROM anon, authenticated;
GRANT ALL ON public.bridge_lockouts TO service_role;
GRANT ALL ON public.bridge_rate_limits TO service_role;
GRANT ALL ON public.bridge_write_nonces TO service_role;