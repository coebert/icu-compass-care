CREATE TABLE public.handover_acknowledgements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  shift_key TEXT NOT NULL,
  action TEXT NOT NULL,
  ack_by UUID,
  ack_name TEXT,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.handover_acknowledgements TO authenticated;
GRANT ALL ON public.handover_acknowledgements TO service_role;

ALTER TABLE public.handover_acknowledgements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can view handover acks"
  ON public.handover_acknowledgements FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated staff can add handover acks"
  ON public.handover_acknowledgements FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated staff can update handover acks"
  ON public.handover_acknowledgements FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated staff can delete handover acks"
  ON public.handover_acknowledgements FOR DELETE TO authenticated USING (true);

CREATE UNIQUE INDEX uq_handover_ack ON public.handover_acknowledgements(patient_id, shift_key, action);
CREATE INDEX idx_handover_ack_shift ON public.handover_acknowledgements(shift_key);