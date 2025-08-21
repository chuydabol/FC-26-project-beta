const fetchFn =
  global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

const EA_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json',
  Referer: 'https://www.ea.com/',
  Origin: 'https://www.ea.com'
};

async function fetchLeagueMatches(clubId) {
  const url = `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch&platform=common-gen5&clubIds=${clubId}`;
  const res = await fetchFn(url, { headers: EA_HEADERS });
  if (!res.ok) throw new Error(`EA responded ${res.status}`);
  const data = await res.json();
  return data?.[clubId] || [];
}

async function saveLeagueMatches(clubId, pool) {
  const matches = await fetchLeagueMatches(clubId);
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
        JSON.stringify(m)
      ]
    );
  }
}

module.exports = { fetchLeagueMatches, saveLeagueMatches };
