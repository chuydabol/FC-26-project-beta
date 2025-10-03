-- Add slug support for players without numeric identifiers
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS slug TEXT;

-- Populate slug for existing non-numeric player ids
UPDATE public.players
   SET slug = player_id
 WHERE slug IS NULL
   AND player_id !~ '^[0-9]+$';

CREATE INDEX IF NOT EXISTS players_slug_idx
  ON public.players (slug)
  WHERE slug IS NOT NULL;
