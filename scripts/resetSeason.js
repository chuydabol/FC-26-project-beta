const { q } = require('../services/pgwrap');
const { rebuildUpclStandings } = require('./rebuildUpclStandings');
const { rebuildUpclLeaders } = require('./rebuildUpclLeaders');

async function resetSeason() {
  await q('TRUNCATE TABLE public.matches CASCADE');
  await q('TRUNCATE TABLE public.player_match_stats');
  await q('TRUNCATE TABLE public.upcl_leaders');
  await q('TRUNCATE TABLE public.upcl_standings');

  await q(`
    UPDATE public.players SET
      goals = 0,
      assists = 0,
      realtimegame = 0,
      shots = 0,
      passesmade = 0,
      passattempts = 0,
      tacklesmade = 0,
      tackleattempts = 0,
      cleansheetsany = 0,
      saves = 0,
      goalsconceded = 0,
      rating = 0,
      mom = 0
  `);

  await q('REFRESH MATERIALIZED VIEW public.mv_league_standings');
  await rebuildUpclStandings();
  await rebuildUpclLeaders();
}

module.exports = { resetSeason };

if (require.main === module) {
  resetSeason()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
