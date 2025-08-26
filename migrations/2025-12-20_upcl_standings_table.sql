CREATE TABLE IF NOT EXISTS public.upcl_standings (
  club_id   TEXT PRIMARY KEY,
  p   INT NOT NULL,
  w   INT NOT NULL,
  d   INT NOT NULL,
  l   INT NOT NULL,
  gf  INT NOT NULL,
  ga  INT NOT NULL,
  gd  INT NOT NULL,
  pts INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
