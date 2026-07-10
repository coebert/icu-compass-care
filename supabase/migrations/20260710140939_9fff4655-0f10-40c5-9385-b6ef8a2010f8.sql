CREATE TABLE public.bridge_sync_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('push','pull')),
  entity TEXT NOT NULL CHECK (entity IN ('patients','investigations')),
  record_count INTEGER NOT NULL DEFAULT 0,
  actor_role TEXT,
  actor_email TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT ON public.bridge_sync_events TO authenticated;
GRANT ALL ON public.bridge_sync_events TO service_role;

ALTER TABLE public.bridge_sync_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view sync events"
ON public.bridge_sync_events
FOR SELECT
TO authenticated
USING (true);

CREATE INDEX idx_bridge_sync_events_created_at ON public.bridge_sync_events (created_at DESC);