-- Reintroduce vproattr column for club-specific attributes
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS vproattr TEXT;
