const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

async function fetchClubLeagueMatches(clubIds) {
  const ids = Array.isArray(clubIds) ? clubIds : [clubIds];
  if (!ids.length) throw new Error('clubIds required');
  const url =
    `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch` +
    `&platform=common-gen5&clubIds=${ids.join(',')}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`EA API error ${res.status}`);
  }
  return res.json();
}

async function fetchRecentLeagueMatches(clubId) {
  const data = await fetchClubLeagueMatches([clubId]);
  return data?.[clubId] || [];
}

async function fetchClubMembers(clubId) {
  if (!clubId) throw new Error('clubId required');
  const url =
    `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${encodeURIComponent(clubId)}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`EA API error ${res.status}`);
  }
  return res.json();
}

module.exports = { fetchClubLeagueMatches, fetchRecentLeagueMatches, fetchClubMembers };
