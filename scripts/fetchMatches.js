const eaApi = require('../services/eaApi');
const pool = require('../db');

async function main() {
  const ids = (process.env.EA_CLUB_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    console.error('EA_CLUB_IDS env var is required');
    process.exit(1);
  }

  const data = await eaApi.fetchClubLeagueMatches(ids);
  let inserted = 0;
  for (const clubId of Object.keys(data || {})) {
    const matches = Array.isArray(data[clubId]) ? data[clubId] : [];
    for (const m of matches) {
      const id = Number(m.matchId);
      const ts = m.timestamp
        ? new Date(m.timestamp).toISOString()
        : (m.matchDate ? new Date(m.matchDate).toISOString() : null);
      try {
        const { rowCount } = await pool.query(
          `INSERT INTO matches (id, timestamp, clubs, players, raw)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO NOTHING`,
          [id, ts, m.clubs || { home: m.home, away: m.away }, m.players || null, m]
        );
        inserted += rowCount;
      } catch (err) {
        console.error('Failed to insert match', id, err);
      }
    }
  }

  console.log(`Inserted ${inserted} new matches`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
