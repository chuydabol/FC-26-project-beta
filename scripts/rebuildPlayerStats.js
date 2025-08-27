const { q } = require('../services/pgwrap');

const SQL_REBUILD_PLAYER_STATS = `
  INSERT INTO public.players (
    player_id, club_id, name, position, vproattr,
    goals, assists, realtimegame, shots, passesmade, passattempts,
    tacklesmade, tackleattempts, cleansheetsany, saves, goalsconceded,
    rating, mom, last_seen
  )
  SELECT pm.player_id,
         pm.club_id,
         COALESCE(p.name, 'Unknown Player') AS name,
         COALESCE(p.position, 'UNK') AS position,
         COALESCE(p.vproattr, '{}'::text) AS vproattr,
         COALESCE(SUM(pm.goals), 0)::int AS goals,
         COALESCE(SUM(pm.assists), 0)::int AS assists,
         COALESCE(SUM(pm.realtimegame), 0)::int AS realtimegame,
         COALESCE(SUM(pm.shots), 0)::int AS shots,
         COALESCE(SUM(pm.passesmade), 0)::int AS passesmade,
         COALESCE(SUM(pm.passattempts), 0)::int AS passattempts,
         COALESCE(SUM(pm.tacklesmade), 0)::int AS tacklesmade,
         COALESCE(SUM(pm.tackleattempts), 0)::int AS tackleattempts,
         COALESCE(SUM(pm.cleansheetsany), 0)::int AS cleansheetsany,
         COALESCE(SUM(pm.saves), 0)::int AS saves,
         COALESCE(SUM(pm.goalsconceded), 0)::int AS goalsconceded,
         COALESCE(AVG(pm.rating), 0)::float AS rating,
         COALESCE(SUM(pm.mom), 0)::int AS mom,
         NOW()
    FROM public.player_match_stats pm
    LEFT JOIN public.players p
      ON p.player_id = pm.player_id AND p.club_id = pm.club_id
   GROUP BY pm.player_id, pm.club_id, p.name, p.position, p.vproattr
  ON CONFLICT (player_id, club_id) DO UPDATE SET
    goals = EXCLUDED.goals,
    assists = EXCLUDED.assists,
    realtimegame = EXCLUDED.realtimegame,
    shots = EXCLUDED.shots,
    passesmade = EXCLUDED.passesmade,
    passattempts = EXCLUDED.passattempts,
    tacklesmade = EXCLUDED.tacklesmade,
    tackleattempts = EXCLUDED.tackleattempts,
    cleansheetsany = EXCLUDED.cleansheetsany,
    saves = EXCLUDED.saves,
    goalsconceded = EXCLUDED.goalsconceded,
    rating = EXCLUDED.rating,
    mom = EXCLUDED.mom,
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
