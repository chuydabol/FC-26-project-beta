const pg = require('./pgwrap');

const SQL = `
  SELECT mp.match_id, mp.club_id,
         COALESCE(SUM(pms.goals), 0)::int AS player_goals,
         mp.goals::int AS team_goals
    FROM public.match_participants mp
    LEFT JOIN public.player_match_stats pms
           ON pms.match_id = mp.match_id AND pms.club_id = mp.club_id
   GROUP BY mp.match_id, mp.club_id, mp.goals
  HAVING COALESCE(SUM(pms.goals), 0)::int <> mp.goals::int
`;

async function checkStatsIntegrity() {
  const { rows } = await pg.q(SQL);
  return rows;
}

module.exports = { checkStatsIntegrity };
