const eaApi = require('../services/eaApi');
const { pool } = require('../db');

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
      const matchId = String(m.matchId);
      const tsMs = Number(m.timestamp) * 1000;
      try {
        const { rowCount } = await pool.query(
          `INSERT INTO public.matches (match_id, ts_ms, raw)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (match_id) DO NOTHING`,
          [matchId, tsMs, m]
        );
        if (rowCount) {
          const entries = Object.entries(m.clubs || {});
          if (entries.length === 2) {
            const [[idA, clubA], [idB, clubB]] = entries;
            const homeId = BigInt(idA) < BigInt(idB) ? idA : idB;
            const [homeData, awayData] = homeId === idA ? [clubA, clubB] : [clubB, clubA];
            const awayId = homeId === idA ? idB : idA;
            const homeGoals = parseInt(homeData?.goals ?? homeData?.score ?? '0', 10);
            const awayGoals = parseInt(awayData?.goals ?? awayData?.score ?? '0', 10);
            await pool.query(
              `INSERT INTO public.match_participants (match_id, club_id, is_home, goals)
               VALUES ($1,$2,TRUE,$3),($1,$4,FALSE,$5)
               ON CONFLICT (match_id, club_id) DO UPDATE SET goals = EXCLUDED.goals`,
              [matchId, homeId, homeGoals, awayId, awayGoals]
            );
            await pool.query(
              `INSERT INTO public.clubs (club_id, club_name) VALUES ($1,$2),($3,$4)
               ON CONFLICT (club_id) DO UPDATE SET club_name = EXCLUDED.club_name`,
              [idA, clubA?.details?.name || '', idB, clubB?.details?.name || '']
            );
          }
          inserted += rowCount;
        }
      } catch (err) {
        console.error('Failed to insert match', matchId, err);
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
