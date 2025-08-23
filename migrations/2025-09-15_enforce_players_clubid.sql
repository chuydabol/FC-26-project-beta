-- Ensure club_id is not null
ALTER TABLE public.players
  ALTER COLUMN club_id SET NOT NULL;
