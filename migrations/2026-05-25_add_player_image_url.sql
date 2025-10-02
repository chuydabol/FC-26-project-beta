-- Add image_url column for player portraits
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS image_url TEXT;
