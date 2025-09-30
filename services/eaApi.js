async function fetchFn(...a) {
  if (global.fetch) return global.fetch(...a);
  const m = await import('node-fetch');
  return m.default(...a);
}
const https = require('https');

// Browser-like headers to avoid EA blocking the requests
const EA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'application/json',
  Referer: 'https://www.ea.com/',
};

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const EA_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 4;
const MAX_CONCURRENT = 2;
const MIN_STAGGER_MS = 250;
const MAX_STAGGER_MS = 500;
const MIN_CACHE_MS = 2 * 60_000;
const MAX_CACHE_MS = 5 * 60_000;

let inFlight = 0;
const queue = [];

function acquire() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise(resolve => queue.push(resolve)).then(() => {
    inFlight++;
  });
}

function release() {
  inFlight--;
  const next = queue.shift();
  if (next) next();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetry(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function backoff(attempt) {
  const base = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return base + jitter;
}

async function limitedFetchOnce(url, options = {}) {
  await acquire();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      ...options,
      headers: { ...EA_HEADERS, ...(options.headers || {}) },
      signal: controller.signal,
      agent,
    });
  } finally {
    clearTimeout(timeout);
    release();
  }
}

async function eaFetch(url, options = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await limitedFetchOnce(url, options);
      if (shouldRetry(res.status) && attempt < MAX_RETRIES) {
        await delay(backoff(attempt));
        continue;
      }
      if (!res.ok) {
        throw { status: res.status };
      }
      return res;
    } catch (err) {
      if ((err.name === 'AbortError' || shouldRetry(err.status)) && attempt < MAX_RETRIES) {
        await delay(backoff(attempt));
        continue;
      }
      throw err;
    }
  }
}

const clubCache = new Map();
const leaderboardCache = new Map();
const LEADERBOARD_CACHE_TTL_MS = 5 * 60_000;

async function fetchClubLeagueMatches(clubIds) {
  const ids = Array.isArray(clubIds) ? clubIds : [clubIds];
  if (!ids.length) throw new Error('clubIds required');

  const results = {};
  for (const id of ids) {
    const cached = clubCache.get(id);
    if (cached && Date.now() < cached.nextFetch) {
      results[id] = cached.data;
      continue;
    }

    const url =
      `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch` +
      `&platform=common-gen5&clubIds=${id}`;
    let data = [];
    try {
      const res = await eaFetch(url);
      const body = await res.json();
      data = Array.isArray(body) ? body : body?.[id] || [];
      console.info(`[EA] Success for club ${id}`);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[EA] Timeout for club ${id}`);
      } else {
        console.warn(`[EA] ${err.status || err.message || 'Error'} for club ${id}`);
      }
    }
    results[id] = Array.isArray(data) ? data : [];

    const ttl =
      MIN_CACHE_MS + Math.random() * (MAX_CACHE_MS - MIN_CACHE_MS);
    clubCache.set(id, { data: results[id], nextFetch: Date.now() + ttl });

    const stagger =
      MIN_STAGGER_MS + Math.random() * (MAX_STAGGER_MS - MIN_STAGGER_MS);
    await delay(stagger);
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
  try {
    const res = await eaFetch(url);
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw { error: 'EA API request timed out' };
    }
    if (err.status) {
      throw { error: 'EA API error', status: err.status };
    }
    if (err && err.error) throw err;
    throw { error: 'EA API error' };
  }
}

async function fetchPlayersForClub(clubId) {
  return fetchClubMembers(clubId);
}

async function fetchClubMembersWithRetry(clubId, retries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchClubMembers(clubId);
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
}

const fetchPlayersForClubWithRetry = fetchClubMembersWithRetry;

function normalizeString(value) {
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return '';
    return String(value);
  }
  return value;
}

function parseDivisionValue(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) {
    return Math.trunc(num);
  }
  return null;
}

function extractEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const candidates = [
    payload.entries,
    payload.results,
    payload.clubs,
    payload.teams,
    payload.data,
    payload.leaderboard,
    payload.leaderboardEntries,
    payload.leaderboard?.entries,
    payload.payload?.entries,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function extractDivisionFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return { name: '', division: null };
  const name = normalizeString(
    entry.clubName ||
      entry.clubname ||
      entry.name ||
      entry.teamName ||
      entry.teamname ||
      entry?.club?.name ||
      entry?.club?.clubName ||
      entry?.clubInfo?.clubName ||
      entry?.clubInfo?.name ||
      entry?.clubinfo?.clubname
  ).trim();

  const division =
    entry.division ??
    entry.divisionId ??
    entry.division_id ??
    entry.divisionNumber ??
    entry.clubDivision ??
    entry?.club?.division ??
    entry?.clubInfo?.division ??
    entry?.clubinfo?.division;

  return { name, division: parseDivisionValue(division) };
}

async function fetchClubDivisionByName(clubName) {
  const normalized = normalizeString(clubName).trim();
  if (!normalized) return null;

  const cacheKey = normalized.toLowerCase();
  const cached = leaderboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.division;
  }

  const url =
    'https://proclubs.ea.com/api/fc/allTimeLeaderboard/search' +
    `?platform=common-gen5&clubName=${encodeURIComponent(normalized)}`;

  try {
    const res = await eaFetch(url);
    const data = await res.json();
    const entries = extractEntries(data);
    let fallback = null;
    const target = normalized.toLowerCase();
    for (const entry of entries) {
      const info = extractDivisionFromEntry(entry);
      if (info.division !== null && fallback === null) {
        fallback = info.division;
      }
      if (info.name && info.name.toLowerCase() === target) {
        if (info.division !== null) {
          leaderboardCache.set(cacheKey, {
            division: info.division,
            expiresAt: Date.now() + LEADERBOARD_CACHE_TTL_MS,
          });
          return info.division;
        }
      }
    }

    const result = fallback;
    leaderboardCache.set(cacheKey, {
      division: result,
      expiresAt: Date.now() + LEADERBOARD_CACHE_TTL_MS,
    });
    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw { error: 'EA API request timed out' };
    }
    if (err.status) {
      throw { error: 'EA API error', status: err.status };
    }
    if (err && err.error) throw err;
    throw { error: 'EA API error' };
  }
}

async function fetchClubInfo(clubId) {
  if (!clubId) throw new Error('clubId required');
  const url =
    `https://proclubs.ea.com/api/fc/clubs/info?platform=common-gen5&clubIds=${encodeURIComponent(
      clubId
    )}`;
  try {
    const res = await eaFetch(url);
    const data = await res.json();
    return data?.[clubId] || {};
  } catch (err) {
    if (err.name === 'AbortError') {
      throw { error: 'EA API request timed out' };
    }
    if (err.status) {
      throw { error: 'EA API error', status: err.status };
    }
    if (err && err.error) throw err;
    throw { error: 'EA API error' };
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
  fetchClubMembersWithRetry,
  fetchPlayersForClubWithRetry,
  fetchClubInfo,
  fetchClubInfoWithRetry,
  fetchClubDivisionByName,
};
