const { q } = require('../services/pgwrap');

async function rebuildLeagueStandings() {
  await q('REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_league_standings');
}

module.exports = { rebuildLeagueStandings };

if (require.main === module) {
  rebuildLeagueStandings()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
