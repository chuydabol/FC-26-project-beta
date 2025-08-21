const fetchFn =
  global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

const EA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.ea.com/',
  Origin: 'https://www.ea.com',
  Connection: 'keep-alive',
};

async function fetchMatchesForClub(clubId) {
  const url = `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch&platform=common-gen5&clubIds=${clubId}`;
  const res = await fetchFn(url, { headers: EA_HEADERS });
  if (!res.ok) throw new Error(`EA responded ${res.status}`);
  const data = await res.json();
  return data?.[clubId] || [];
}

async function fetchAndStoreMatches(clubIds = [], pool, delayMs = 300) {
  for (const id of clubIds) {
    try {
      const matches = await fetchMatchesForClub(id);
      for (const m of matches) {
        await pool.query(
          `INSERT INTO matches (id, "timestamp", clubs, players, raw)
           VALUES ($1, to_timestamp($2 / 1000), $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [
            String(m.matchId),
            m.timestamp,
            JSON.stringify(m.clubs || {}),
            JSON.stringify(m.players || {}),
            JSON.stringify(m),
          ]
        );
      }
    } catch (err) {
      console.error('Failed to fetch/store matches for club', id, err.message || err);
    }
    if (delayMs) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

module.exports = { fetchAndStoreMatches };
