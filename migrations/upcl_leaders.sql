DROP MATERIALIZED VIEW IF EXISTS public.upcl_leaders;

CREATE TABLE IF NOT EXISTS public.upcl_leaders (
  type    TEXT NOT NULL,
  club_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  count   INT  NOT NULL,
  PRIMARY KEY (type, club_id, name)
);

