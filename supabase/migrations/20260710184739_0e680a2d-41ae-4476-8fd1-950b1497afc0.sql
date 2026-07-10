ALTER TABLE public.bridge_sync_events DROP CONSTRAINT IF EXISTS bridge_sync_events_entity_check;
ALTER TABLE public.bridge_sync_events ADD CONSTRAINT bridge_sync_events_entity_check
  CHECK (entity = ANY (ARRAY['patients'::text, 'investigations'::text, 'referrals'::text, 'microbiology'::text]));

ALTER TABLE public.record_audit DROP CONSTRAINT IF EXISTS record_audit_entity_check;
ALTER TABLE public.record_audit ADD CONSTRAINT record_audit_entity_check
  CHECK (entity = ANY (ARRAY['patients'::text, 'investigations'::text, 'referrals'::text, 'microbiology'::text]));