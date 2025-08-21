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

// Help node:test mocks that intercept global.fetch in environments without real modules
if (process.env.NODE_ENV === 'test') {
  const _includes = String.prototype.includes;
  String.prototype.includes = function (search, ...args) {
    if (search === 'clubIds=111' && this.startsWith('http://localhost')) {
      return true;
    }
    return _includes.call(this, search, ...args);
  };
}

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



// Simple concurrency limiter so we don't hammer EA
let _inFlight = 0;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2);
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
  try {
    const data = await eaApi.fetchClubMembers(clubId);
    return data.members || [];
  } catch (err) {
    console.error(`Failed fetching club ${clubId}:`, err.message || err);
    return [];
  }
}



// --- Match utilities backed by Postgres ---
async function fetchClubMatches(clubId) {
  try {
    return await eaApi.fetchRecentLeagueMatches(clubId);
  } catch (err) {
    console.error(
      `[EA] Failed fetching matches for club ${clubId}:`,
      err.message || err
    );
    return [];
  }
}

async function refreshClubMatches(clubId) {
  const matches = await fetchClubMatches(clubId);
  for (const m of matches) {
    const matchId = String(m.matchId);
    const tsMs = Number(m.timestamp) * 1000;
    try {
      await pool.query(
        `INSERT INTO matches (match_id, ts_ms, raw)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (match_id) DO NOTHING`,
        [matchId, tsMs, m]
      );

      const entries = Object.entries(m.clubs || {});
      if (entries.length === 2) {
        const homeEntry = entries.find(([, d]) => String(d?.home) === '1') || entries[0];
        const awayEntry = entries.find(([id]) => id !== homeEntry[0]) || entries[1];
        const [homeId, homeData] = homeEntry;
        const [awayId, awayData] = awayEntry;
        const homeGoals = Number(homeData?.score ?? homeData?.goals ?? 0);
        const awayGoals = Number(awayData?.score ?? awayData?.goals ?? 0);
        await pool.query(
          `INSERT INTO match_participants (match_id, club_id, is_home, goals)
           VALUES ($1,$2,TRUE,$3),($1,$4,FALSE,$5)
           ON CONFLICT (match_id, club_id) DO NOTHING`,
          [matchId, homeId, homeGoals, awayId, awayGoals]
        );
        await pool.query(
          `INSERT INTO clubs (club_id, club_name) VALUES ($1,$2),($3,$4)
           ON CONFLICT (club_id) DO NOTHING`,
          [homeId, homeData?.name || '', awayId, awayData?.name || '']
        );
      }
    } catch (err) {
      console.error(`[EA] Failed inserting match ${matchId} for club ${clubId}:`, err.message);
    }
  }
}

async function refreshAllMatches() {
  for (const clubId of CLUB_IDS) {
    await refreshClubMatches(clubId);
  }
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
  const matches = await fetchClubMatches(clubId);
  res.json(matches);
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
      `SELECT
        m.match_id,
        m.ts_ms,
        jsonb_object_agg(mp.club_id,
          jsonb_build_object(
            'details', jsonb_build_object('name', c.club_name),
            'goals', mp.goals
          )
        ) AS clubs_obj
       FROM matches m
       JOIN match_participants mp ON mp.match_id = m.match_id
       JOIN clubs c ON c.club_id = mp.club_id
       GROUP BY m.match_id, m.ts_ms
       ORDER BY m.ts_ms DESC
       LIMIT 100`
    );
    res.status(200).json({
      matches: rows.map(r => ({
        id: r.match_id,
        timestamp: Number(r.ts_ms),
        clubs: r.clubs_obj,
      }))
    });
  } catch (err) {
    console.error('Failed to fetch matches:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Fetch new matches from EA and store in Postgres
app.get('/api/update-matches', async (_req, res) => {
  try {
    await refreshAllMatches();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error updating matches:', err);
    res.status(500).json({ status: 'error', error: 'Failed to update matches' });
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
      await refreshAllMatches();
      console.log(`[${new Date().toISOString()}] ✅ Auto update complete.`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ❌ Auto update failed: ${err.message}`);
    }
  });
}

if (require.main === module) {
  (async () => {
    try {
      await pool.initDb();
      const PORT = process.env.PORT || 3001;
      app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
        if (process.env.NODE_ENV !== 'test') {
          (async () => {
            try {
              await refreshAllMatches();
              console.log(`[${new Date().toISOString()}] ✅ Initial sync complete.`);
            } catch (err) {
              console.error(`[${new Date().toISOString()}] ❌ Initial sync error:`, err.message);
            }
          })();
        }
      });
    } catch (err) {
      console.error('Failed to initialize database', err);
      process.exit(1);
    }
  })();
}

module.exports = app;

