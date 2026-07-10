-- Reliable updated_at for conflict detection
CREATE TRIGGER trg_patients_updated_at
BEFORE UPDATE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Audit trail of all changes
CREATE TABLE public.record_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('patients','investigations')),
  record_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','bridge')),
  actor_id UUID,
  actor_role TEXT,
  actor_email TEXT,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  before JSONB,
  after JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT ON public.record_audit TO authenticated;
GRANT ALL ON public.record_audit TO service_role;

ALTER TABLE public.record_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view audit"
ON public.record_audit
FOR SELECT
TO authenticated
USING (true);

CREATE INDEX idx_record_audit_record ON public.record_audit (entity, record_id, created_at DESC);
