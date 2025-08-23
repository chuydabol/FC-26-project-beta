-- Allow players to exist in multiple clubs and track stats per club
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_pkey CASCADE;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS goals INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assists INT DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE public.players
    ADD CONSTRAINT players_pid_cid_unique UNIQUE (player_id, club_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;
