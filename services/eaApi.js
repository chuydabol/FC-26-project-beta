const https = require('https');

const EA_BASE_URL = 'https://proclubs.ea.com/api/fc';
const EA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'application/json',
  Referer: 'https://www.ea.com/',
};
const EA_TIMEOUT_MS = Number(process.env.EA_TIMEOUT_MS || 25_000);
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const cache = new Map();
const CACHE_TTL_MS = Number(process.env.EA_CACHE_TTL_MS || 60_000);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeClubId(clubId) {
  const id = String(clubId || '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('clubId must be numeric');
  }
  return id;
}

function isMatchPayload(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (
    value.matchId !== undefined ||
    value.matchid !== undefined ||
    value.id !== undefined ||
    value.clubs !== undefined ||
    value.players !== undefined
  ));
}

function getMatchPayloadId(match) {
  const id = match?.matchId ?? match?.matchid ?? match?.id;
  return id === undefined || id === null || id === '' ? null : String(id);
}

function appendUniqueMatch(matches, seenIds, match) {
  const id = getMatchPayloadId(match);
  if (id) {
    if (seenIds.has(id)) return;
    seenIds.add(id);
  }
  matches.push(match);
}

function collectMatchesPayload(value, clubId, matches, seenIds) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) collectMatchesPayload(item, clubId, matches, seenIds);
    return;
  }

  if (isMatchPayload(value)) {
    appendUniqueMatch(matches, seenIds, value);
    return;
  }

  if (typeof value !== 'object') return;

  if (value[clubId] !== undefined) {
    collectMatchesPayload(value[clubId], clubId, matches, seenIds);
    return;
  }

  if (value.matches !== undefined) {
    collectMatchesPayload(value.matches, clubId, matches, seenIds);
  }
}

function readMatchesPayload(body, clubId) {
  const matches = [];
  collectMatchesPayload(body, String(clubId), matches, new Set());
  return matches;
}

async function eaFetchJson(url, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: EA_HEADERS,
        signal: controller.signal,
        agent,
      });
      if (!response.ok) {
        const error = new Error(`EA API returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    } catch (error) {
      lastError = error;
      const retryable = error.name === 'AbortError' || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === retries) break;
      await delay(500 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchClubMatches(clubId, matchType = 'friendlyMatch') {
  const id = normalizeClubId(clubId);
  const type = String(matchType || 'friendlyMatch').trim() || 'friendlyMatch';
  const key = `${type}:${id}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.matches;

  const params = new URLSearchParams({
    matchType: type,
    platform: 'common-gen5',
    clubIds: id,
  });
  const body = await eaFetchJson(`${EA_BASE_URL}/clubs/matches?${params}`);
  const matches = readMatchesPayload(body, id);
  cache.set(key, { matches, expiresAt: Date.now() + CACHE_TTL_MS });
  return matches;
}


function readMembersPayload(body) {
  if (!body || typeof body !== 'object') {
    return { members: [], positionCount: {} };
  }

  const members = Array.isArray(body.members) ? body.members : [];
  const positionCount = body.positionCount && typeof body.positionCount === 'object' ? body.positionCount : {};
  return { members, positionCount };
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMember(member = {}, index = 0) {
  const name = String(member.name || member.playerName || member.proName || `Player ${index + 1}`).trim();
  return {
    id: String(member.id || member.userId || member.personaId || `${name}-${index}`),
    name,
    gamesPlayed: toNumber(member.gamesPlayed),
    winRate: toNumber(member.winRate),
    goals: toNumber(member.goals),
    assists: toNumber(member.assists),
    passesMade: toNumber(member.passesMade),
    passSuccessRate: toNumber(member.passSuccessRate),
    ratingAve: toNumber(member.ratingAve),
    tacklesMade: toNumber(member.tacklesMade),
    tackleSuccessRate: toNumber(member.tackleSuccessRate),
    manOfTheMatch: toNumber(member.manOfTheMatch),
    redCards: toNumber(member.redCards),
    favoritePosition: String(member.favoritePosition || 'N/A'),
    proName: String(member.proName || name),
    proOverall: toNumber(member.proOverall),
    proOverallStr: String(member.proOverallStr || member.proOverall || '—'),
  };
}

function normalizeMembersStats(body) {
  const { members, positionCount } = readMembersPayload(body);
  return {
    members: members.map(normalizeMember),
    positionCount,
  };
}

async function fetchMembersStats(clubId) {
  const id = normalizeClubId(clubId);
  const key = `members:${id}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const params = new URLSearchParams({
    platform: 'common-gen5',
    clubId: id,
  });
  const body = await eaFetchJson(`${EA_BASE_URL}/members/stats?${params}`);
  const data = normalizeMembersStats(body);
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function fetchFriendlyMatches(clubId) {
  return fetchClubMatches(clubId, 'friendlyMatch');
}

module.exports = {
  fetchClubMatches,
  fetchMembersStats,
  normalizeMember,
  normalizeMembersStats,
  readMembersPayload,
  fetchFriendlyMatches,
  normalizeClubId,
  readMatchesPayload,
};
