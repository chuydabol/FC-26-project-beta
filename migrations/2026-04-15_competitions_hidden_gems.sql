-- Expand players with overall rating and add competition/news infrastructure
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS overall_rating double precision;

CREATE TABLE IF NOT EXISTS public.pending_matches (
  match_id TEXT PRIMARY KEY,
  source_club_id BIGINT NOT NULL,
  opponent_club_id BIGINT NOT NULL,
  match_timestamp TIMESTAMPTZ,
  raw JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.competition_matches (
  id BIGSERIAL PRIMARY KEY,
  competition_id TEXT NOT NULL,
  group_name TEXT,
  round_name TEXT,
  match_id TEXT NOT NULL,
  home_club_id BIGINT NOT NULL,
  away_club_id BIGINT NOT NULL,
  home_score INT NOT NULL DEFAULT 0,
  away_score INT NOT NULL DEFAULT 0,
  played_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (competition_id, match_id)
);

CREATE TABLE IF NOT EXISTS public.competition_standings (
  competition_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  club_id BIGINT NOT NULL,
  played INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  draws INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  goals_for INT NOT NULL DEFAULT 0,
  goals_against INT NOT NULL DEFAULT 0,
  points INT NOT NULL DEFAULT 0,
  goal_diff INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (competition_id, group_name, club_id)
);

ALTER TABLE public.news
  DROP CONSTRAINT IF EXISTS news_type_check;

ALTER TABLE public.news
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE public.news SET type = 'manual_post' WHERE type = 'manual';
UPDATE public.news SET type = 'standings_snapshot' WHERE type = 'auto';

ALTER TABLE public.news
  ADD CONSTRAINT news_type_check
  CHECK (type IN ('standings_snapshot', 'hidden_gem', 'manual_post'));

CREATE INDEX IF NOT EXISTS idx_pending_matches_created_at
  ON public.pending_matches (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_matches_match_ts
  ON public.pending_matches (match_timestamp DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_competition_matches_competition
  ON public.competition_matches (competition_id, group_name);

CREATE INDEX IF NOT EXISTS idx_news_expires_at
  ON public.news (expires_at);

ALTER TABLE public.player_match_stats
  ADD COLUMN IF NOT EXISTS competition_id TEXT;
