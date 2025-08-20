const fetchFn =
  global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

// Browser-like headers to avoid EA blocking the requests
const EA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'application/json',
  Referer: 'https://www.ea.com/',
};

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
      headers: EA_HEADERS,
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
      headers: EA_HEADERS,
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
      headers: EA_HEADERS,
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

async function fetchPlayersForClubWithRetry(clubId, retries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await module.exports.fetchPlayersForClub(clubId);
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
}

module.exports = {
  fetchClubLeagueMatches,
  fetchRecentLeagueMatches,
  fetchClubMembers,
  fetchPlayersForClub,
  fetchPlayersForClubWithRetry
};
