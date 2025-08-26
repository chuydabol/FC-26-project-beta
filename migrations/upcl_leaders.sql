CREATE MATERIALIZED VIEW IF NOT EXISTS public.upcl_leaders AS
WITH league_players AS (
  SELECT p.club_id, p.name, p.goals, p.assists
    FROM public.players p
    JOIN public.upcl_standings s ON s.club_id = p.club_id
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
