-- Update players table to store latest attributes and tracking
ALTER TABLE public.players
  ALTER COLUMN club_id DROP NOT NULL,
  ALTER COLUMN vproattr TYPE TEXT USING vproattr::text,
  ALTER COLUMN vproattr DROP DEFAULT;

UPDATE public.players SET name = 'Unknown Player' WHERE name IS NULL;
ALTER TABLE public.players ALTER COLUMN name SET NOT NULL;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP DEFAULT now();
