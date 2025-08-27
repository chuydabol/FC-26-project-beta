-- Track per-match player stats
CREATE TABLE IF NOT EXISTS public.player_match_stats (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  goals INT NOT NULL DEFAULT 0,
  assists INT NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, player_id, club_id)
);
