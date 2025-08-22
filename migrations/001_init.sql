CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  score JSONB,
  status TEXT,
  details JSONB,
  league_id TEXT,
  played_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  details JSONB
);

CREATE TABLE IF NOT EXISTS ea_last_matches (
  club_id TEXT PRIMARY KEY,
  last_match_id TEXT
);

CREATE TABLE IF NOT EXISTS clubs (
  club_id   TEXT PRIMARY KEY,
  club_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  match_id  TEXT  PRIMARY KEY,
  ts_ms     BIGINT NOT NULL,
  raw       JSONB  NOT NULL
);

ALTER TABLE matches RENAME COLUMN IF EXISTS id TO match_id;
ALTER TABLE matches DROP COLUMN IF EXISTS club_id;

CREATE TABLE IF NOT EXISTS match_participants (
  match_id  TEXT   NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  club_id   TEXT   NOT NULL REFERENCES clubs(club_id),
  is_home   BOOLEAN NOT NULL,
  goals     INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_ts_ms_desc ON matches (ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_mp_club_ts ON match_participants (club_id, match_id);

CREATE TABLE IF NOT EXISTS teams (
  id BIGINT PRIMARY KEY,
  name TEXT,
  logo JSONB,
  season JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  club_id BIGINT REFERENCES teams(id),
  name TEXT,
  position TEXT,
  stats JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
