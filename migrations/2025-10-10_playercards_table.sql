-- Create table for player attribute snapshots and drop vproattr from players
CREATE TABLE IF NOT EXISTS public.playercards (
  player_id TEXT PRIMARY KEY REFERENCES public.players(player_id),
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  vproattr TEXT NOT NULL,
  ovr INT NOT NULL,
  last_updated TIMESTAMP DEFAULT now()
);

ALTER TABLE public.players DROP COLUMN IF EXISTS vproattr;
