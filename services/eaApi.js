const fetchFn =
  global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

const USER_AGENT =
  process.env.EA_USER_AGENT || 'UPCL/1.0 (https://your-domain.example)';

async function fetchClubLeagueMatches(clubIds) {
  const ids = Array.isArray(clubIds) ? clubIds : [clubIds];
  if (!ids.length) throw new Error('clubIds required');
  const url =
    `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch` +
    `&platform=common-gen5&clubIds=${ids.join(',')}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': USER_AGENT,
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
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': USER_AGENT,
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

async function fetchPlayersForClub(clubId) {
  if (!clubId) throw new Error('clubId required');
  const url =
    `https://proclubs.ea.com/api/fc/clubs/${encodeURIComponent(
      clubId
    )}/members?platform=common-gen5`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': USER_AGENT,
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

module.exports = {
  fetchClubLeagueMatches,
  fetchRecentLeagueMatches,
  fetchClubMembers,
  fetchPlayersForClub
};
