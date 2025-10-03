const { q } = require('../services/pgwrap');

const SQL_LEADERS = `
  WITH league_players AS (
    SELECT pms.club_id::bigint AS club_id,
           p.name,
           SUM(pms.goals)   AS goals,
           SUM(pms.assists) AS assists
      FROM public.player_match_stats pms
      JOIN public.matches m ON m.match_id::bigint = pms.match_id::bigint
      JOIN public.players p ON p.player_id::bigint = pms.player_id::bigint
      JOIN public.upcl_standings s ON s.club_id::bigint = pms.club_id::bigint
      GROUP BY pms.club_id::bigint, pms.player_id::bigint, p.name
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
`;

async function rebuildUpclLeaders() {
  await q('TRUNCATE TABLE public.upcl_leaders');
  await q('INSERT INTO public.upcl_leaders (type, club_id, name, count) ' + SQL_LEADERS);
}

module.exports = { rebuildUpclLeaders };

if (require.main === module) {
  rebuildUpclLeaders()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

