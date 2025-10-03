const pg = require('./pgwrap');

const SQL = `
  SELECT mp.match_id, mp.club_id,
         COALESCE(SUM(pms.goals), 0)::int AS player_goals,
         mp.goals::int AS team_goals
    FROM public.match_participants mp
    LEFT JOIN public.player_match_stats pms
           ON pms.match_id::bigint = mp.match_id::bigint AND pms.club_id::bigint = mp.club_id::bigint
   GROUP BY mp.match_id, mp.club_id, mp.goals
  HAVING COALESCE(SUM(pms.goals), 0)::int <> mp.goals::int
`;

async function checkStatsIntegrity() {
  const { rows } = await pg.q(SQL);
  return rows;
}

module.exports = { checkStatsIntegrity };
