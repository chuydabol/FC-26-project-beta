const fetchFn =
  global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

// Browser-like headers to avoid EA blocking the requests
const EA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'application/json',
  Referer: 'https://www.ea.com/',
};

const EA_TIMEOUT_MS = 30_000;
const FETCH_DELAY_MS = 1_500;
const RETRY_DELAYS_MS = [2_000, 5_000];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchClubLeagueMatches(clubIds) {
  const ids = Array.isArray(clubIds) ? clubIds : [clubIds];
  if (!ids.length) throw new Error('clubIds required');

  const results = {};
  for (const id of ids) {
    const url =
      `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch` +
      `&platform=common-gen5&clubIds=${id}`;
    let data = [];
    let fetched = false;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
      try {
        const res = await fetchFn(url, {
          headers: EA_HEADERS,
          signal: controller.signal
        });
        if (res.status === 500) {
          throw { status: 500 };
        }
        if (!res.ok) {
          throw { status: res.status };
        }
        const body = await res.json();
        data = Array.isArray(body) ? body : body?.[id] || [];
        console.info(`[EA] Success for club ${id}`);
        fetched = true;
        break;
      } catch (err) {
        if (err.name === 'AbortError') {
          console.warn(`[EA] Timeout for club ${id}`);
        } else if (err.status === 500) {
          console.warn(`[EA] 500 for club ${id}`);
        } else {
          console.warn(`[EA] ${err.status || err.message || 'Error'} for club ${id}`);
        }
        if (attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt]);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    results[id] = data;
    if (!fetched) {
      // give up after retries but continue with next club
      results[id] = Array.isArray(results[id]) ? results[id] : [];
    }
    await delay(FETCH_DELAY_MS);
  }
  return results;
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
  const timeout = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
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
  const timeout = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
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

async function fetchClubInfo(clubId) {
  if (!clubId) throw new Error('clubId required');
  const url =
    `https://proclubs.ea.com/api/fc/clubs/info?platform=common-gen5&clubIds=${encodeURIComponent(
      clubId
    )}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      headers: EA_HEADERS,
      signal: controller.signal
    });
    if (!res.ok) {
      throw { error: 'EA API error', status: res.status };
    }
    const data = await res.json();
    return data?.[clubId] || {};
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

async function fetchClubInfoWithRetry(clubId, retries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await module.exports.fetchClubInfo(clubId);
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
  fetchPlayersForClubWithRetry,
  fetchClubInfo,
  fetchClubInfoWithRetry
};
