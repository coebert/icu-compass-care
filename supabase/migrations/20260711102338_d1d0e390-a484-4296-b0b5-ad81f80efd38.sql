ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS anticoagulation text[] DEFAULT '{}' NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patients TO authenticated;
GRANT ALL ON public.patients TO service_role;

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;