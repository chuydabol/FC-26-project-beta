const { q } = require('../services/pgwrap');

const SQL_REBUILD_PLAYER_STATS = `
  INSERT INTO public.players (player_id, club_id, name, position, vproattr, goals, assists, last_seen)
  SELECT pm.player_id,
         pm.club_id,
         COALESCE(p.name, 'Unknown Player') AS name,
         COALESCE(p.position, 'UNK') AS position,
         COALESCE(p.vproattr, '{}'::text) AS vproattr,
         COALESCE(SUM(pm.goals), 0)::int AS goals,
         COALESCE(SUM(pm.assists), 0)::int AS assists,
         NOW()
    FROM public.player_match_stats pm
    LEFT JOIN public.players p
      ON p.player_id = pm.player_id AND p.club_id = pm.club_id
   GROUP BY pm.player_id, pm.club_id, p.name, p.position, p.vproattr
  ON CONFLICT (player_id, club_id) DO UPDATE SET
    goals = EXCLUDED.goals,
    assists = EXCLUDED.assists,
    last_seen = NOW()
`;

async function rebuildPlayerStats() {
  await q(SQL_REBUILD_PLAYER_STATS);
}

module.exports = { rebuildPlayerStats };

if (require.main === module) {
  rebuildPlayerStats()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
