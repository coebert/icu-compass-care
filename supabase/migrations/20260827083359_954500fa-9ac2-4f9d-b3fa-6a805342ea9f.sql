CREATE TABLE public.account_access_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  target_user_id uuid,
  target_email text,
  target_display_name text,
  action text NOT NULL,
  role text,
  reason text,
  note text,
  actor_id uuid,
  actor_email text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX account_access_events_created_at_idx ON public.account_access_events (created_at DESC);
CREATE INDEX account_access_events_target_idx ON public.account_access_events (target_user_id);

GRANT SELECT ON public.account_access_events TO authenticated;
GRANT ALL ON public.account_access_events TO service_role;

ALTER TABLE public.account_access_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view account access events"
  ON public.account_access_events
  FOR SELECT
  TO authenticated
  USING (private.has_role(auth.uid(), 'admin'));
