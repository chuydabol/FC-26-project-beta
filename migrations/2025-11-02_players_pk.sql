-- Ensure players table has a primary key for player_id to support upserts
ALTER TABLE public.players
  ADD CONSTRAINT players_pkey PRIMARY KEY (player_id);
