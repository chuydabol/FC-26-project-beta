-- Create players table to cache player attributes from matches
CREATE TABLE IF NOT EXISTS public.players (
  player_id TEXT PRIMARY KEY,
  club_id   TEXT NOT NULL,
  name      TEXT,
  position  TEXT,
  vproattr  JSONB NOT NULL DEFAULT '{}'::jsonb
);
