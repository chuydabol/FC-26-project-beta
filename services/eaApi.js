const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function fetchClubLeagueMatches(clubIds) {
  const ids = Array.isArray(clubIds) ? clubIds : [clubIds];
  if (!ids.length) throw new Error('clubIds required');
  const url =
    `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch` +
    `&platform=common-gen5&clubIds=${ids.join(',')}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'fc-26-project-beta',
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw { error: 'EA API error', status: res.status };
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw { error: 'EA API request timed out' };
    }
    if (err && err.error) throw err;
    throw { error: 'EA API error' };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRecentLeagueMatches(clubId) {
  const data = await fetchClubLeagueMatches([clubId]);
  return data?.[clubId] || [];
}

async function fetchClubMembers(clubId) {
  if (!clubId) throw new Error('clubId required');
  const url =
    `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${encodeURIComponent(clubId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'fc-26-project-beta',
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw { error: 'EA API error', status: res.status };
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw { error: 'EA API request timed out' };
    }
    if (err && err.error) throw err;
    throw { error: 'EA API error' };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchClubLeagueMatches, fetchRecentLeagueMatches, fetchClubMembers };
