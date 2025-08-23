-- Ensure player position defaults to 'UNK'
ALTER TABLE public.players
  ALTER COLUMN position SET DEFAULT 'UNK';

UPDATE public.players SET position = 'UNK' WHERE position IS NULL;
