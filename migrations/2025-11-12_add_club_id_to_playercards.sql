-- Allow player cards to be club-specific
ALTER TABLE public.playercards
  ADD COLUMN club_id TEXT NOT NULL REFERENCES public.clubs(club_id);

ALTER TABLE public.playercards
  DROP CONSTRAINT IF EXISTS playercards_pkey,
  DROP CONSTRAINT IF EXISTS playercards_player_id_fkey;

ALTER TABLE public.playercards
  ADD CONSTRAINT playercards_pkey PRIMARY KEY (player_id, club_id),
  ADD CONSTRAINT playercards_player_fkey FOREIGN KEY (player_id, club_id)
    REFERENCES public.players(player_id, club_id);
