CREATE TABLE IF NOT EXISTS public.league_standings (
  club_id TEXT PRIMARY KEY REFERENCES public.clubs(club_id),
  points INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  draws INT DEFAULT 0,
  goals_for INT DEFAULT 0,
  goals_against INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
