CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_league_standings AS
WITH matches AS (
  SELECT home.club_id AS home,
         away.club_id AS away,
         home.goals AS home_goals,
         away.goals AS away_goals
    FROM public.matches m
    JOIN public.match_participants home
      ON home.match_id = m.match_id AND home.is_home = true
    JOIN public.match_participants away
      ON away.match_id = m.match_id AND away.is_home = false
),
sides AS (
  SELECT home AS club_id, away AS opp_id, home_goals AS gf, away_goals AS ga
    FROM matches
  UNION ALL
  SELECT away AS club_id, home AS opp_id, away_goals AS gf, home_goals AS ga
    FROM matches
)
SELECT c.club_id,
       COALESCE(COUNT(s.club_id), 0)::int AS played,
       COALESCE(SUM(CASE WHEN s.gf > s.ga THEN 1 ELSE 0 END), 0)::int AS wins,
       COALESCE(SUM(CASE WHEN s.gf = s.ga THEN 1 ELSE 0 END), 0)::int AS draws,
       COALESCE(SUM(CASE WHEN s.gf < s.ga THEN 1 ELSE 0 END), 0)::int AS losses,
       COALESCE(SUM(s.gf), 0)::int AS goals_for,
       COALESCE(SUM(s.ga), 0)::int AS goals_against,
       COALESCE(SUM(s.gf - s.ga), 0)::int AS goal_diff,
       COALESCE(SUM(CASE WHEN s.gf > s.ga THEN 3 WHEN s.gf = s.ga THEN 1 ELSE 0 END), 0)::int AS points
  FROM public.clubs c
  LEFT JOIN sides s ON c.club_id = s.club_id
 GROUP BY c.club_id
 ORDER BY points DESC, goal_diff DESC, goals_for DESC;

CREATE UNIQUE INDEX IF NOT EXISTS mv_league_standings_pk
  ON public.mv_league_standings (club_id);
