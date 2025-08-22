-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS public;

-- Clubs
CREATE TABLE IF NOT EXISTS public.clubs (
  club_id   TEXT PRIMARY KEY,
  club_name TEXT NOT NULL
);

-- Matches: NO club_id here
CREATE TABLE IF NOT EXISTS public.matches (
  match_id  TEXT  PRIMARY KEY,
  ts_ms     BIGINT NOT NULL,
  raw       JSONB  NOT NULL
);

-- Remove accidental column if it exists
ALTER TABLE public.matches DROP COLUMN IF EXISTS club_id;

-- Participants: club_id belongs here
CREATE TABLE IF NOT EXISTS public.match_participants (
  match_id  TEXT   NOT NULL REFERENCES public.matches(match_id) ON DELETE CASCADE,
  club_id   TEXT   NOT NULL REFERENCES public.clubs(club_id),
  is_home   BOOLEAN NOT NULL,
  goals     INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, club_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_matches_ts_ms_desc ON public.matches (ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_mp_club_ts        ON public.match_participants (club_id, match_id);
