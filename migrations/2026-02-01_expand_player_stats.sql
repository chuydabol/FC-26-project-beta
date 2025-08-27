ALTER TABLE public.player_match_stats
  ADD COLUMN realtimegame integer DEFAULT 0,
  ADD COLUMN shots integer DEFAULT 0,
  ADD COLUMN passesmade integer DEFAULT 0,
  ADD COLUMN passattempts integer DEFAULT 0,
  ADD COLUMN tacklesmade integer DEFAULT 0,
  ADD COLUMN tackleattempts integer DEFAULT 0,
  ADD COLUMN cleansheetsany integer DEFAULT 0,
  ADD COLUMN saves integer DEFAULT 0,
  ADD COLUMN goalsconceded integer DEFAULT 0,
  ADD COLUMN rating double precision DEFAULT 0,
  ADD COLUMN mom integer DEFAULT 0;

ALTER TABLE public.players
  ADD COLUMN realtimegame integer DEFAULT 0,
  ADD COLUMN shots integer DEFAULT 0,
  ADD COLUMN passesmade integer DEFAULT 0,
  ADD COLUMN passattempts integer DEFAULT 0,
  ADD COLUMN tacklesmade integer DEFAULT 0,
  ADD COLUMN tackleattempts integer DEFAULT 0,
  ADD COLUMN cleansheetsany integer DEFAULT 0,
  ADD COLUMN saves integer DEFAULT 0,
  ADD COLUMN goalsconceded integer DEFAULT 0,
  ADD COLUMN rating double precision DEFAULT 0,
  ADD COLUMN mom integer DEFAULT 0;
