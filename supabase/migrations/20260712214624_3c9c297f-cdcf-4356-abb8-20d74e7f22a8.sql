-- Normalize existing names: trim + collapse internal whitespace
UPDATE public.antimicrobial_library
SET name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
WHERE name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

-- Remove duplicates that collide on the canonical form, keeping the earliest row
DELETE FROM public.antimicrobial_library a
USING public.antimicrobial_library b
WHERE lower(btrim(regexp_replace(a.name, '\s+', ' ', 'g')))
    = lower(btrim(regexp_replace(b.name, '\s+', ' ', 'g')))
  AND (a.created_at > b.created_at
       OR (a.created_at = b.created_at AND a.id > b.id));

-- Replace the case-only index with a canonical (trimmed + collapsed + lowercased) unique index
DROP INDEX IF EXISTS public.antimicrobial_library_name_lower_idx;

CREATE UNIQUE INDEX antimicrobial_library_name_canonical_idx
  ON public.antimicrobial_library (lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))));