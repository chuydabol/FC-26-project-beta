const express = require('express');
const session = require('express-session');
let cors;
try {
  cors = require('cors');
} catch {
  // Fallback minimal CORS middleware if package isn't installed
  cors = () => (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set(
        'Access-Control-Allow-Methods',
        'GET,HEAD,PUT,PATCH,POST,DELETE'
      );
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
    next();
  };
}
const path = require('path');
const pool = require('./db');
const eaApi = require('./services/eaApi');
const { isNumericId } = require('./utils');

let cron;
try {
  cron = require('node-cron');
} catch {
  // Fallback minimal scheduler if node-cron isn't installed
  cron = {
    schedule: (_expr, fn) => {
      const t = setInterval(fn, 15 * 60 * 1000);
      if (typeof t.unref === 'function') t.unref();
      return t;
    }
  };
}

// Fallback fetch for environments without global fetch
const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

// Explicit club list used for league operations
const CLUB_IDS = [
  '2491998', // Royal Republic
  '1527486', // Gungan FC
  '1969494', // Club Frijol
  '2086022', // Brehemen
  '2462194', // Costa Chica FC
  '5098824', // Sporting de la ma
  '4869810', // Afc Tekki
  '576007', // Ethabella FC
  '481847', // Rooney tunes
  '3050467', // invincible afc
  '4933507', // Loss Toyz
  '4824736', // GoldenGoals FC
  '4154835', // khalch Fc
  '3638105', // Real mvc
  '55408', // Elite VT
  '4819681', // EVERYTHING DEAD
  '35642' // EBK FC
];

const CLUB_NAMES = {
  '2491998': 'Royal Republic',
  '1527486': 'Gungan FC',
  '1969494': 'Club Frijol',
  '2086022': 'Brehemen',
  '2462194': 'Costa Chica FC',
  '5098824': 'Sporting de la ma',
  '4869810': 'Afc Tekki',
  '576007': 'Ethabella FC',
  '4933507': 'Loss Toyz',
  '4824736': 'GoldenGoals FC',
  '481847': 'Rooney tunes',
  '3050467': 'invincible afc',
  '4154835': 'khalch Fc',
  '3638105': 'Real mvc',
  '55408': 'Elite VT',
  '4819681': 'EVERYTHING DEAD',
  '35642': 'EBK FC'
};

const DEFAULT_CLUB_IDS = CLUB_IDS.slice();


// Browser-like headers for EA API
const EA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.ea.com/',
  Origin: 'https://www.ea.com',
  Connection: 'keep-alive'
};

// Simple concurrency limiter so we don't hammer EA
let _inFlight = 0;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);
const _queue = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _inFlight++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        _inFlight--;
        const next = _queue.shift();
        if (next) next();
      }
    };
    if (_inFlight < MAX_CONCURRENCY) run();
    else _queue.push(run);
  });
}

// Cache for /api/players
let _playersCache = { at: 0, data: null };
const PLAYERS_TTL_MS = 60_000;

// Cache for club info lookups
const _clubInfoCache = new Map();
const CLUB_INFO_TTL_MS = 60_000;

// Fetch helper with logging
async function fetchClubPlayers(clubId) {
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  try {
    const res = await fetchFn(url, { headers: EA_HEADERS });
    if (!res.ok) throw new Error(`EA responded ${res.status}`);
    const data = await res.json();
    return data.members || [];
  } catch (err) {
    console.error(`Failed fetching club ${clubId}:`, err.message);
    return [];
  }
}

async function fetchClubLeagueMatches(clubId) {
  const url = `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch&platform=common-gen5&clubIds=${clubId}`;
  const fetcher =
    global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));
  const res = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok)
    throw new Error(`Failed fetching club ${clubId}, status: ${res.status}`);
  const data = await res.json();
  return data?.[clubId] || [];
}

// --- Match utilities backed by Postgres ---
const LEAGUE_START_DATE = new Date('2025-07-23T07:00:00Z');

function isAfterLeagueStart(match) {
  const ts = match.timestamp || match.matchTimestamp;
  if (!ts) return false;
  const date = new Date(ts * 1000);
  return date >= LEAGUE_START_DATE;
}

async function trimMatchesToLimit(limit = 10) {
  const { rows } = await pool.query(
    'SELECT id, "timestamp", clubs FROM matches WHERE "timestamp" >= $1',
    [LEAGUE_START_DATE]
  );

  const clubMatchMap = {};
  rows.forEach(row => {
    const ts = new Date(row.timestamp).getTime();
    const clubs = row.clubs || {};
    Object.keys(clubs).forEach(id => {
      if (!clubMatchMap[id]) clubMatchMap[id] = [];
      clubMatchMap[id].push({ id: row.id, ts });
    });
  });

  Object.keys(clubMatchMap).forEach(id => {
    clubMatchMap[id].sort((a, b) => a.ts - b.ts);
  });

  const excessIds = new Set();
  for (const id of CLUB_IDS) {
    const matches = clubMatchMap[id] || [];
    if (matches.length > limit) {
      matches.slice(0, matches.length - limit).forEach(m => excessIds.add(m.id));
    }
  }

  if (excessIds.size) {
    await pool.query('DELETE FROM matches WHERE id = ANY($1::bigint[])', [
      Array.from(excessIds)
    ]);
  }
}

async function deleteMatchesForClubBeforeDate(clubId, cutoffDateStr) {
  const cutoff = new Date(cutoffDateStr);
  await pool.query(
    'DELETE FROM matches WHERE "timestamp" < $1 AND clubs ? $2',
    [cutoff, clubId]
  );
}

async function cleanOldMatches() {
  await pool.query('DELETE FROM matches WHERE "timestamp" < $1', [
    LEAGUE_START_DATE
  ]);
}

async function fetchMatches(clubId) {
  try {
    const url = `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch&platform=common-gen5&clubIds=${clubId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Status ${response.status}`);
    }

    const matches = await response.json();

    let matchesArray = [];

    if (Array.isArray(matches)) {
      matchesArray = matches;
    } else if (typeof matches === 'object' && matches !== null) {
      for (const key of Object.keys(matches)) {
        if (Array.isArray(matches[key])) {
          matchesArray = matchesArray.concat(matches[key]);
        }
      }
    }

    return matchesArray;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching matches for club ${clubId}:`, error.message);
    return [];
  }
}

async function saveNewMatches(matches) {
  const { rows } = await pool.query(
    'SELECT id, clubs FROM matches WHERE "timestamp" >= $1',
    [LEAGUE_START_DATE]
  );
  const existingMatchIds = new Set(rows.map(r => String(r.id)));
  const matchCountPerClub = {};
  rows.forEach(r => {
    const clubs = r.clubs || {};
    Object.keys(clubs).forEach(id => {
      matchCountPerClub[id] = (matchCountPerClub[id] || 0) + 1;
    });
  });

  const SKIP_BEFORE = {
    '3638105': new Date('2025-07-23T10:00:00Z')
  };

  let savedCount = 0;
  for (const match of matches) {
    const matchId = match.matchId?.toString() || match.id?.toString();
    if (!matchId || existingMatchIds.has(matchId)) continue;

    const ts = match.timestamp || match.matchTimestamp;
    const matchDate = ts ? new Date(ts * 1000) : null;
    if (!matchDate || matchDate < LEAGUE_START_DATE) continue;

    const clubs = match.clubs || {};
    const clubIds = Object.keys(clubs);
    if (clubIds.length !== 2) continue;
    if (!clubIds.some(id => CLUB_IDS.includes(id))) continue;

    const skipForClub = clubIds.some(id => {
      const cutoff = SKIP_BEFORE[id];
      return cutoff && matchDate < cutoff;
    });
    if (skipForClub) continue;

    const anyOverLimit = clubIds.some(
      id => (matchCountPerClub[id] || 0) >= 10
    );
    if (anyOverLimit) continue;

    await pool.query(
      `INSERT INTO matches (id, "timestamp", clubs, players, raw)
       VALUES ($1, to_timestamp($2), $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        matchId,
        ts,
        JSON.stringify(match.clubs || {}),
        JSON.stringify(match.players || {}),
        JSON.stringify(match)
      ]
    );
    savedCount++;
    existingMatchIds.add(matchId);
    clubIds.forEach(id => {
      matchCountPerClub[id] = (matchCountPerClub[id] || 0) + 1;
    });
  }

  return savedCount;
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'teams.html'))
);

// Basic admin session endpoints
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD || 'admin';
  if (!password || password !== expected) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: !!req.session?.isAdmin });
});

// Proxy to fetch club members from EA API (avoids browser CORS)
app.get('/api/ea/clubs/:clubId/members', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ error: 'Invalid clubId' });
  }

  try {
    const raw = await limit(() => eaApi.fetchPlayersForClubWithRetry(clubId));
    let members = [];
    if (Array.isArray(raw)) {
      members = raw;
    } else if (Array.isArray(raw?.members)) {
      members = raw.members;
    } else if (raw?.members && typeof raw.members === 'object') {
      members = Object.values(raw.members);
    }
    return res.json({ members });
  } catch (err) {
    const msg = err?.error || err?.message || 'EA API error';
    const status = /abort|timeout|timed out|ETIMEDOUT/i.test(String(msg))
      ? 504
      : 502;
    return res
      .status(status)
      .json({ error: 'EA API request failed', details: msg });
  }
});

// Proxy to fetch club info from EA API
app.get('/api/ea/clubs/:clubId/info', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ error: 'Invalid clubId' });
  }

  const cached = _clubInfoCache.get(clubId);
  if (cached && Date.now() - cached.at < CLUB_INFO_TTL_MS) {
    return res.json({ club: cached.data });
  }

  try {
    const info = await limit(() => eaApi.fetchClubInfoWithRetry(clubId));
    _clubInfoCache.set(clubId, { at: Date.now(), data: info });
    return res.json({ club: info });
  } catch (err) {
    const msg = err?.error || err?.message || 'EA API error';
    const status = /abort|timeout|timed out|ETIMEDOUT/i.test(String(msg))
      ? 504
      : 502;
    return res
      .status(status)
      .json({ error: 'EA API request failed', details: msg });
  }
});

// Fetch recent matches for a single club directly from EA
app.get('/api/ea/matches/:clubId', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ error: 'Invalid clubId' });
  }

  const url =
    `https://proclubs.ea.com/api/fc/clubs/matches?matchType=leagueMatch&platform=common-gen5&clubIds=${clubId}`;

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`EA API error ${r.status}`);
    const data = await r.json();
    res.json(data?.[clubId] || []);
  } catch (err) {
    console.error('EA matches fetch failed', err);
    res.status(500).json({ error: 'EA API error' });
  }
});

// Basic teams listing
app.get('/api/teams', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM teams ORDER BY updated_at DESC LIMIT 20'
    );
    res.json({ ok: true, teams: rows });
  } catch (err) {
    console.error('Failed to load teams:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recent matches served from Postgres
app.get('/api/matches', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM matches ORDER BY "timestamp" DESC LIMIT 100'
    );
    res.status(200).json(rows);
  } catch (err) {
    console.error('Failed to fetch matches:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Delete matches for a specific club before a cutoff date
app.post('/api/delete-3638105-before-3am', async (_req, res) => {
  try {
    await deleteMatchesForClubBeforeDate('3638105', '2025-07-23T10:00:00Z');
    res.status(200).send({ message: 'Matches deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to delete matches.' });
  }
});

// Clean matches before league start
app.post('/api/clean-old-matches', async (_req, res) => {
  try {
    await cleanOldMatches();
    res.status(200).send({ message: 'Old matches cleaned.' });
  } catch (err) {
    console.error('Error cleaning old matches:', err.message);
    res.status(500).send({ error: 'Failed to clean old matches.' });
  }
});

// Fetch new matches from EA and store in Postgres
app.get('/api/update-matches', async (_req, res) => {
  try {
    await trimMatchesToLimit(10);
    let allMatches = [];
    for (const clubId of CLUB_IDS) {
      const matches = await fetchMatches(clubId);
      allMatches = allMatches.concat(matches);
    }
    const saved = await saveNewMatches(allMatches);
    res.status(200).send(`Saved ${saved} new matches.`);
  } catch (err) {
    console.error('Error updating matches:', err);
    res.status(500).json({ error: 'Failed to update matches' });
  }
});

// Aggregate players from league
app.get('/api/players', async (req, res) => {
  // Allow explicit override (?clubIds=1,2,3), otherwise use default league list
  const q = req.query.clubId || req.query.clubIds || req.query.ids || '';
  let clubIds = Array.isArray(q)
    ? q
    : String(q)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
  if (!clubIds.length) clubIds = DEFAULT_CLUB_IDS.slice();
  clubIds = clubIds.filter(isNumericId);

  // serve from short cache if fresh
  if (_playersCache.data && Date.now() - _playersCache.at < PLAYERS_TTL_MS) {
    return res.json(_playersCache.data);
  }

  const byClub = {};
  const union = [];
  const seen = new Set();

  for (const id of clubIds) {
    const members = await fetchClubPlayers(id);
    byClub[id] = members;

    for (const p of members) {
      const name = p?.name || p?.playername || p?.personaName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      union.push(p);
    }
  }

  const payload = { byClub, union, clubIds };
  _playersCache = { at: Date.now(), data: payload };
  res.json(payload);
});

// Auto update every 10 minutes
if (process.env.NODE_ENV !== 'test') {
  cron.schedule('*/10 * * * *', async () => {
    console.log(`[${new Date().toISOString()}] Auto update starting...`);
    try {
      await cleanOldMatches();
      for (const clubId of CLUB_IDS) {
        const matches = await fetchMatches(clubId);
        await saveNewMatches(matches);
      }
      console.log(`[${new Date().toISOString()}] ✅ Auto update complete.`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ❌ Auto update failed: ${err.message}`);
    }
  });
}

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
    if (process.env.NODE_ENV !== 'test') {
      (async () => {
        try {
          await cleanOldMatches();
          await deleteMatchesForClubBeforeDate('3638105', '2025-07-23T10:00:00Z');
          let allMatches = [];
          for (const clubId of CLUB_IDS) {
            const matches = await fetchMatches(clubId);
            allMatches = allMatches.concat(matches);
          }
          await saveNewMatches(allMatches);
          await trimMatchesToLimit(10);
          console.log(`[${new Date().toISOString()}] ✅ Initial sync complete.`);
        } catch (err) {
          console.error(`[${new Date().toISOString()}] ❌ Initial sync error:`, err.message);
        }
      })();
    }
  });
}

module.exports = app;

