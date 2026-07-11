-- Phase 1: structured safety fields on patients
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS allergies jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS weight_kg numeric(5,1),
  ADD COLUMN IF NOT EXISTS daily_goals jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS daily_goals_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS daily_goals_reviewed_by text;

COMMENT ON COLUMN public.patients.allergies IS 'Structured allergy list: [{substance, reaction, severity}]';
COMMENT ON COLUMN public.patients.daily_goals IS 'FAST-HUG style daily goals checklist: {vte, stress_ulcer, glucose, sedation_hold, head_up, catheter_review, bowels, nutrition}';