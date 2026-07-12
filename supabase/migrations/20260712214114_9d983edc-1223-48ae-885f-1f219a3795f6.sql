CREATE TABLE public.antimicrobial_library (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Prevent duplicates that differ only by case (e.g. "Meropenem" vs "meropenem").
CREATE UNIQUE INDEX antimicrobial_library_name_lower_idx
  ON public.antimicrobial_library (lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.antimicrobial_library TO authenticated;
GRANT ALL ON public.antimicrobial_library TO service_role;

ALTER TABLE public.antimicrobial_library ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view antimicrobial library"
  ON public.antimicrobial_library FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Staff can add antimicrobial names"
  ON public.antimicrobial_library FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "Staff can edit antimicrobial names"
  ON public.antimicrobial_library FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "Staff can remove antimicrobial names"
  ON public.antimicrobial_library FOR DELETE TO authenticated
  USING (true);

CREATE TRIGGER update_antimicrobial_library_updated_at
  BEFORE UPDATE ON public.antimicrobial_library
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();