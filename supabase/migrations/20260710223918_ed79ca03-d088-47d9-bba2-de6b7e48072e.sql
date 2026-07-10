-- Security-definer role check (avoids RLS recursion).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Bed roster for the Radnor Critical Care bed board, editable by admins.
CREATE TABLE public.icu_beds (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label text NOT NULL,
  position integer NOT NULL,
  is_side_room boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT icu_beds_label_unique UNIQUE (label)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.icu_beds TO authenticated;
GRANT ALL ON public.icu_beds TO service_role;

ALTER TABLE public.icu_beds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view beds"
  ON public.icu_beds FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert beds"
  ON public.icu_beds FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins can update beds"
  ON public.icu_beds FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins can delete beds"
  ON public.icu_beds FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER update_icu_beds_updated_at
  BEFORE UPDATE ON public.icu_beds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.icu_beds (label, position, is_side_room) VALUES
  ('SR1', 1, true),
  ('SR2', 2, true),
  ('3', 3, false),
  ('4', 4, false),
  ('5', 5, false),
  ('6', 6, false),
  ('7', 7, false),
  ('8', 8, false),
  ('9', 9, false),
  ('10', 10, false);