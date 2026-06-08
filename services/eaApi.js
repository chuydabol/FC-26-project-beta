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

function readMatchesPayload(body, clubId) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.matches)) return body.matches;
  if (Array.isArray(body?.[clubId])) return body[clubId];
  return [];
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

function fetchFriendlyMatches(clubId) {
  return fetchClubMatches(clubId, 'friendlyMatch');
}

module.exports = {
  fetchClubMatches,
  fetchFriendlyMatches,
  normalizeClubId,
  readMatchesPayload,
};
