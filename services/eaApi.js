const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

async function fetchRecentLeagueMatches(clubId){
  if(!clubId) throw new Error('clubId required');
  const url = `https://proclubs.ea.com/api/fc/matches?matchType=league&clubIds=${clubId}`;
  const res = await fetchFn(url);
  if(!res.ok){
    throw new Error(`EA API error ${res.status}`);
  }
  return res.json();
}

module.exports = { fetchRecentLeagueMatches };
