-- Replay/idempotency store for partner-bridge WRITE requests.
-- Each successful write records a SHA-256 fingerprint of its HMAC signature.
-- A duplicate fingerprint (within the signature's validity window) means the
-- exact same signed request is being replayed, and is rejected.
CREATE TABLE public.bridge_write_nonces (
  signature_hash TEXT PRIMARY KEY,
  seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Accessed only by backend service-role code (supabaseAdmin, RLS bypassed).
-- No anon/authenticated grants: this must never be reachable via the Data API.
GRANT ALL ON public.bridge_write_nonces TO service_role;

ALTER TABLE public.bridge_write_nonces ENABLE ROW LEVEL SECURITY;
-- No policies: with RLS enabled and no policies, anon/authenticated get zero
-- access; service_role bypasses RLS entirely.

CREATE INDEX idx_bridge_write_nonces_seen_at ON public.bridge_write_nonces (seen_at);