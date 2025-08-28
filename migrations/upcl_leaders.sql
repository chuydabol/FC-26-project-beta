CREATE MATERIALIZED VIEW IF NOT EXISTS public.upcl_leaders AS
WITH league_players AS (
  SELECT pms.club_id,
         p.name,
         SUM(pms.goals)   AS goals,
         SUM(pms.assists) AS assists
    FROM public.player_match_stats pms
    JOIN public.matches m
      ON m.match_id = pms.match_id
    JOIN public.players p
      ON p.player_id = pms.player_id
    JOIN public.upcl_standings s
      ON s.club_id = pms.club_id
   WHERE m.ts_ms BETWEEN $league_start AND $league_end
   GROUP BY pms.club_id, pms.player_id, p.name
),
scorers AS (
  SELECT 'scorer'::text AS type,
         club_id,
         name,
         goals AS count,
         ROW_NUMBER() OVER (ORDER BY goals DESC, name) AS rn
    FROM league_players
   WHERE goals > 0
),
assisters AS (
  SELECT 'assister'::text AS type,
         club_id,
         name,
         assists AS count,
         ROW_NUMBER() OVER (ORDER BY assists DESC, name) AS rn
    FROM league_players
   WHERE assists > 0
)
SELECT type, club_id, name, count
  FROM (
    SELECT type, club_id, name, count, rn FROM scorers WHERE rn <= 10
    UNION ALL
    SELECT type, club_id, name, count, rn FROM assisters WHERE rn <= 10
  ) AS leaders
 ORDER BY type, count DESC, name;
