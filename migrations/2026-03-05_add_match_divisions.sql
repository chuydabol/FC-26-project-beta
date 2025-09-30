-- Add division columns to matches for home and away clubs
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS home_division INT,
  ADD COLUMN IF NOT EXISTS away_division INT;
