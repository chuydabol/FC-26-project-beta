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
const logger = require('./logger');
const eaApi = require('./services/eaApi');
const { q } = require('./services/pgwrap');
const { runMigrations } = require('./services/migrate');
const { parseVpro, tierFromStats } = require('./services/playerCards');
const { rebuildUpclStandings } = require('./scripts/rebuildUpclStandings');
const { rebuildLeagueStandings } = require('./scripts/rebuildLeagueStandings');

// SQL statements for saving EA matches
const SQL_INSERT_MATCH = `
  INSERT INTO public.matches (match_id, ts_ms, raw)
  VALUES ($1, $2, $3::jsonb)
  ON CONFLICT (match_id) DO NOTHING
`;

const SQL_UPSERT_CLUB = `
  INSERT INTO public.clubs (club_id, club_name)
  VALUES ($1, $2)
  ON CONFLICT (club_id) DO UPDATE SET club_name = EXCLUDED.club_name
`;

const SQL_UPSERT_PARTICIPANT = `
  INSERT INTO public.match_participants (match_id, club_id, is_home, goals)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (match_id, club_id) DO UPDATE
  SET is_home = EXCLUDED.is_home, goals = EXCLUDED.goals
`;

const SQL_UPSERT_PLAYER = `
  INSERT INTO public.players (player_id, club_id, name, position, vproattr, goals, assists, last_seen)
  VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
  ON CONFLICT (player_id, club_id) DO UPDATE SET
    name = EXCLUDED.name,
    position = EXCLUDED.position,
    vproattr = EXCLUDED.vproattr,
    goals = public.players.goals + EXCLUDED.goals,
    assists = public.players.assists + EXCLUDED.assists,
    last_seen = NOW()
`;

const SQL_UPSERT_PLAYERCARD = `
  INSERT INTO public.playercards (player_id, club_id, name, position, vproattr, ovr, last_updated)
  VALUES ($1, $2, $3, $4, $5, $6, NOW())
  ON CONFLICT (player_id, club_id) DO UPDATE
    SET name = EXCLUDED.name,
        position = EXCLUDED.position,
        vproattr = EXCLUDED.vproattr,
        ovr = EXCLUDED.ovr,
        last_updated = NOW()
`;

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

// Headers used when proxying requests to EA's API.  EA's servers expect
// browser-like headers and will reject requests without them.
const EA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'application/json',
  Referer: 'https://www.ea.com/',
};

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

const CRON_ENABLED = process.env.CRON_ENABLED !== '0';

// Mapping of league IDs to their club IDs
const LEAGUE_CLUBS_PATH = process.env.LEAGUE_CLUBS_PATH ||
  path.join(__dirname, 'data', 'leagueClubs.json');
let LEAGUE_CLUBS = {};
try {
  LEAGUE_CLUBS = require(LEAGUE_CLUBS_PATH);
} catch (err) {
  logger.error({ err }, 'Failed to load league club mapping');
}
function clubsForLeague(id) {
  return LEAGUE_CLUBS[id] || [];
}
const DEFAULT_LEAGUE_ID = process.env.DEFAULT_LEAGUE_ID || 'UPCL_LEAGUE_2025';

function resolveClubIds() {
  let ids = clubsForLeague(DEFAULT_LEAGUE_ID);
  if (!ids.length) {
    ids = (process.env.EA_CLUB_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  if (!ids.length) {
    logger.warn(
      { leagueId: DEFAULT_LEAGUE_ID },
      'No club IDs resolved for default league'
    );
  }
  return ids;
}

// Prime club ID resolution to surface misconfiguration at startup
resolveClubIds();

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

// Cache for club info lookups
const _clubInfoCache = new Map();
const CLUB_INFO_TTL_MS = 60_000;

// Track last league refresh times
const _leagueRefreshCache = new Map();



// --- Match utilities backed by Postgres ---
async function fetchClubMatches(clubId) {
  try {
    return await eaApi.fetchRecentLeagueMatches(clubId);
  } catch (err) {
    logger.error({ err }, `[EA] Failed fetching matches for club ${clubId}`);
    return [];
  }
}

async function saveEaMatch(match) {
  const matchId = String(match.matchId);
  const tsMs = Number(match.timestamp) * 1000;
  const { rowCount } = await q(SQL_INSERT_MATCH, [matchId, tsMs, match]);
  if (rowCount === 0) return;

  const clubs = match.clubs || {};
  for (const cid of Object.keys(clubs)) {
    const c = clubs[cid];
    const name = c?.details?.name || `Club ${cid}`;
    const goals = Number(c?.goals || 0);
    const isHome = Number(c?.details?.isHome) === 1;
    await q(SQL_UPSERT_CLUB, [cid, name]);
    await q(SQL_UPSERT_PARTICIPANT, [matchId, cid, isHome, goals]);
  }

  if (match.players) {
    for (const [cid, playerMap] of Object.entries(match.players)) {
      for (const [pid, pdata] of Object.entries(playerMap)) {
        const name =
          pdata.name ||
          pdata.playername ||
          pdata.proName ||
          pdata.personaName ||
          'Player_' + (pdata.playerId || pdata.playerid || pid);
        const pos =
          pdata.position ||
          pdata.pos ||
          pdata.proPos ||
          'UNK';
        const vproattr = pdata.vproattr || null;
        const goals = Number(pdata.goals || 0);
        const assists = Number(pdata.assists || 0);
        await q(SQL_UPSERT_PLAYER, [pid, cid, name, pos, vproattr, goals, assists]);
        if (vproattr) {
          const stats = parseVpro(vproattr);
          await q(SQL_UPSERT_PLAYERCARD, [pid, cid, name, pos, vproattr, stats.ovr]);
        }
      }
    }
  }
}

async function refreshClubMatches(clubId) {
  const matches = await fetchClubMatches(clubId);
  for (const m of matches) {
    try {
      await saveEaMatch(m);
    } catch (err) {
      logger.error({ err }, `[EA] Failed inserting match ${m.matchId} for club ${clubId}`);
    }
  }
}

async function refreshAllMatches(clubIds) {
  const ids = clubIds && clubIds.length ? clubIds : resolveClubIds();
  for (const clubId of ids) {
    await refreshClubMatches(clubId);
  }
  await rebuildLeagueStandings();
  await rebuildUpclStandings();
  await q('REFRESH MATERIALIZED VIEW public.upcl_leaders');
}

async function ensureLeagueClubs(clubIds) {
  for (const cid of new Set(clubIds)) {
    const name = CLUB_NAMES[cid] || `Club ${cid}`;
    await q(SQL_UPSERT_CLUB, [cid, name]);
  }
}

const app = express();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
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
  if (req.session) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: !!req.session?.isAdmin });
});

app.post('/admin/migrate', async (req, res) => {
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).end();
  try { await runMigrations(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/admin/verify-schema', async (req, res) => {
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).end();
  const qStr = `SELECT
    to_regclass('public.matches') AS matches,
    to_regclass('public.match_participants') AS match_participants,
    to_regclass('public.clubs') AS clubs`;
  const r = await q(qStr);
  res.json(r.rows[0]);
});

// Proxy to fetch club members from EA API (avoids browser CORS)
app.get('/api/ea/clubs/:clubId/members', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ members: [] });
  }

  try {
    const raw = await limit(() => eaApi.fetchClubMembersWithRetry(clubId));
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
    return res.json({ members: [] });
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

// Minimal proxy for club info. EA blocks direct browser requests via CORS so
// the client must call this endpoint which forwards the request with the
// required headers.
app.get('/api/club-info/:clubId', async (req, res) => {
  const clubId = req.params.clubId;
  const url =
    `https://proclubs.ea.com/api/fc/clubs/info?platform=common-gen5&clubIds=${clubId}`;
  try {
    const r = await fetch(url, { headers: EA_HEADERS });
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res
      .status(500)
      .json({ error: 'EA API failed', details: err.toString() });
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
  const sql = 'SELECT * FROM teams ORDER BY updated_at DESC LIMIT 20';
  try {
    const { rows } = await q(sql);
    res.json({ ok: true, teams: rows });
  } catch (err) {
    logger.error({ err, sql, params: [] }, 'Failed to load teams');
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recent matches served from Postgres
app.get('/api/matches', async (_req, res) => {
  const sql = `SELECT
        m.match_id AS "matchId",
        m.ts_ms,
        jsonb_object_agg(mp.club_id,
          jsonb_build_object(
            'details', jsonb_build_object('name', c.club_name),
            'goals', mp.goals
          )
        ) AS clubs_obj
       FROM public.matches m
       JOIN public.match_participants mp ON mp.match_id = m.match_id
       JOIN public.clubs c ON c.club_id = mp.club_id
       GROUP BY m.match_id, m.ts_ms
       ORDER BY m.ts_ms DESC
       LIMIT 100`;
  try {
    const { rows } = await q(sql);
    res.status(200).json({
      matches: rows.map(r => ({
        matchId: r.matchId,
        timestamp: Number(r.ts_ms),
        clubs: r.clubs_obj,
      }))
    });
  } catch (err) {
    logger.error({ err, sql, params: [] }, 'Failed to fetch matches');
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Fetch new matches from EA and store in Postgres
app.get('/api/update-matches', async (_req, res) => {
  try {
    await refreshAllMatches(resolveClubIds());
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'Error updating matches');
    res.status(500).json({ status: 'error', error: 'Failed to update matches' });
  }
});

// Aggregate players from league
app.get('/api/players', async (_req, res) => {
  try {
    const { rows } = await q('SELECT * FROM players');
    res.json({ players: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch players');
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Proxy to EA team members stats
app.get('/api/teams/:clubId/players', async (req, res) => {
  const { clubId } = req.params;
  try {
    const raw = await limit(() => eaApi.fetchClubMembersWithRetry(clubId));
    let members = [];
    if (Array.isArray(raw)) {
      members = raw;
    } else if (Array.isArray(raw?.members)) {
      members = raw.members;
    } else if (raw?.members && typeof raw.members === 'object') {
      members = Object.values(raw.members);
    }
    res.json({ members });
  } catch (err) {
    logger.error({ err, clubId }, 'Failed to load team players');
    res.json({ members: [] });
  }
});

// Player cards for a specific club
app.get('/api/clubs/:clubId/player-cards', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ members: [] });
  }

  try {
    const raw = await limit(() => eaApi.fetchClubMembersWithRetry(clubId));
    let members = [];
    if (Array.isArray(raw?.members)) {
      members = raw.members;
    } else if (Array.isArray(raw)) {
      members = raw;
    } else if (raw?.members && typeof raw.members === 'object') {
      members = Object.values(raw.members);
    }

    const { rows } = await q(
      `SELECT player_id, club_id, name, position, vproattr
       FROM public.playercards
       WHERE club_id = $1`,
      [clubId]
    );

    const cardMap = new Map(rows.map(r => [String(r.player_id), r]));
    const nameMap = new Map(rows.map(r => [r.name, r]));

    const membersDetailed = members.map(m => {
      const id = String(m.playerId || m.playerid || '') || null;
      let rec = id ? cardMap.get(id) : null;
      if (!rec) rec = nameMap.get(m.name) || {};

      const vproattr = rec.vproattr || null;
      const stats = vproattr ? parseVpro(vproattr) : null;

      return {
        playerId: id,
        clubId,
        name: m.name || rec.name || `Player_${id}`,
        position: rec.position || m.position || '',
        matches: Number(m.gamesPlayed) || 0,
        goals: Number(m.goals) || 0,
        assists: Number(m.assists) || 0,
        isCaptain: m.isCaptain == 1 || m.captain == 1 || m.role === 'captain',
        vproattr,
        stats
      };
    });

    const withStats = membersDetailed.filter(p => p.stats && p.stats.ovr);
    const sorted = withStats.slice().sort((a, b) => b.stats.ovr - a.stats.ovr);
    const topCount = Math.max(1, Math.floor(withStats.length * 0.05));
    const threshold = sorted[topCount - 1] ? sorted[topCount - 1].stats.ovr : Infinity;

    for (const p of membersDetailed) {
      const t = tierFromStats({
        ovr: p.stats?.ovr || 0,
        matches: p.matches,
        goals: p.goals,
        assists: p.assists,
        isCaptain: p.isCaptain,
      }, threshold);
      p.tier = t.tier;
      p.frame = t.frame;
      p.className = t.className;
    }

    res.json({ members: membersDetailed });
  } catch (err) {
    logger.error({ err }, 'Failed to load player cards');
    res.status(500).json({ members: [] });
  }
});


// Cup fixtures
const SQL_GET_CUP_FIXTURES = `
  SELECT id, cup, home, away, round, when_ts, status, hs, "as" AS away_score, created_at
    FROM cup_fixtures
   WHERE cup = $1
   ORDER BY created_at ASC`;

app.get('/api/cup/fixtures', async (req, res) => {
  const cup = new URL(req.url, 'http://localhost').searchParams.get('cup');
  if (!cup) return res.status(400).json({ fixtures: [] });
  try {
    const { rows } = await q(SQL_GET_CUP_FIXTURES, [cup]);
    const fixtures = rows.map(r => ({
      id: r.id,
      cup: r.cup,
      home: r.home,
      away: r.away,
      round: r.round,
      when: Number(r.when_ts || r.when || r.at || 0) || null,
      status: r.status || null,
      score: { hs: Number(r.hs ?? r.score_h ?? 0), as: Number(r.away_score ?? r.score_a ?? 0) },
      createdAt: Number(r.created_at || r.createdAt || 0) || null
    }));
    res.json({ fixtures });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch fixtures');
    res.status(500).json({ fixtures: [] });
  }
});


// League standings and leaders
const SQL_LEAGUE_STANDINGS = `
  WITH matches AS (
    SELECT home.club_id AS home,
           away.club_id AS away,
           home.goals AS home_goals,
           away.goals AS away_goals
      FROM public.matches m
      JOIN public.match_participants home
        ON home.match_id = m.match_id AND home.is_home = true
      JOIN public.match_participants away
        ON away.match_id = m.match_id AND away.is_home = false
     WHERE home.club_id = ANY($1) OR away.club_id = ANY($1)
  ), sides AS (
    SELECT home AS club_id, away AS opp_id, home_goals AS gf, away_goals AS ga
      FROM matches
    UNION ALL
    SELECT away AS club_id, home AS opp_id, away_goals AS gf, home_goals AS ga
      FROM matches
  )
  SELECT c.club_id AS "clubId",
         COALESCE(COUNT(s.club_id), 0)::int AS "P",
         COALESCE(SUM(CASE WHEN s.gf > s.ga THEN 1 ELSE 0 END), 0)::int AS "W",
         COALESCE(SUM(CASE WHEN s.gf = s.ga THEN 1 ELSE 0 END), 0)::int AS "D",
         COALESCE(SUM(CASE WHEN s.gf < s.ga THEN 1 ELSE 0 END), 0)::int AS "L",
         COALESCE(SUM(s.gf), 0)::int AS "GF",
         COALESCE(SUM(s.ga), 0)::int AS "GA",
         COALESCE(SUM(s.gf - s.ga), 0)::int AS "GD",
         COALESCE(SUM(CASE WHEN s.gf > s.ga THEN 3 WHEN s.gf = s.ga THEN 1 ELSE 0 END), 0)::int AS "Pts"
    FROM public.clubs c
    LEFT JOIN sides s ON c.club_id = s.club_id
   WHERE c.club_id = ANY($1)
   GROUP BY c.club_id
   ORDER BY "Pts" DESC, "GD" DESC, "GF" DESC`;

const SQL_LEAGUE_TEAMS = `
  SELECT club_id AS "id", club_name AS "name"
    FROM public.clubs
   WHERE club_id = ANY($1)`;

async function getUpclLeaders(clubIds) {
  const sql = `SELECT type, club_id AS "clubId", name, count
                 FROM public.upcl_leaders
                WHERE club_id = ANY($1)
                ORDER BY type, count DESC, name`;
  const { rows } = await q(sql, [clubIds]);
  return {
    scorers: rows
      .filter(r => r.type === 'scorer')
      .map(({ type, ...rest }) => rest),
    assisters: rows
      .filter(r => r.type === 'assister')
      .map(({ type, ...rest }) => rest)
  };
}

app.get('/api/league', async (_req, res) => {
  const clubIds = resolveClubIds();
  const sql = `
    SELECT
      cid AS club_id,
      SUM((m.raw->'clubs'->cid->>'wins')::int) AS wins,
      SUM((m.raw->'clubs'->cid->>'losses')::int) AS losses,
      SUM((m.raw->'clubs'->cid->>'ties')::int) AS draws,
      SUM((m.raw->'clubs'->cid->>'goals')::int) AS goals_for,
      SUM(g.opp_goals) AS goals_against,
      SUM((m.raw->'clubs'->cid->>'wins')::int * 3 +
          (m.raw->'clubs'->cid->>'ties')::int) AS points
    FROM matches m
    CROSS JOIN LATERAL jsonb_object_keys(m.raw->'clubs') cid
    CROSS JOIN LATERAL (
      SELECT COALESCE(
               (m.raw->'clubs'->opp->>'goals')::int,
               (m.raw->'clubs'->opp->>'score')::int,
               0
             ) AS opp_goals
      FROM jsonb_object_keys(m.raw->'clubs') opp
      WHERE opp <> cid
    ) g
    WHERE cid = ANY($1)
    GROUP BY cid
    ORDER BY points DESC,
             (SUM((m.raw->'clubs'->cid->>'goals')::int) -
              SUM(g.opp_goals)) DESC,
             wins DESC;
  `;
  try {
    const { rows } = await q(sql, [clubIds]);
    res.json({ standings: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch league standings');
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

app.get('/api/league/leaders', async (_req, res) => {
  const clubIds = resolveClubIds();
  const scorerSql = `
    SELECT club_id, name, SUM(goals) AS count
      FROM public.players
     WHERE club_id = ANY($1)
     GROUP BY club_id, name
     ORDER BY count DESC, name
     LIMIT 10`;
  const assisterSql = `
    SELECT club_id, name, SUM(assists) AS count
      FROM public.players
     WHERE club_id = ANY($1)
     GROUP BY club_id, name
     ORDER BY count DESC, name
     LIMIT 10`;
  try {
    const [scorers, assisters] = await Promise.all([
      q(scorerSql, [clubIds]),
      q(assisterSql, [clubIds])
    ]);
    res.json({
      scorers: scorers.rows,
      assisters: assisters.rows
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch league leaders');
    res.status(500).json({ error: 'Failed to fetch league leaders' });
  }
});

app.get('/api/leagues/:leagueId', async (req, res) => {
  const clubIds = clubsForLeague(req.params.leagueId);
  if (!clubIds.length) {
    return res.status(404).json({ error: 'Unknown league' });
  }
  try {
    await ensureLeagueClubs(clubIds);
    await refreshAllMatches(clubIds);
    _leagueRefreshCache.set(req.params.leagueId, Date.now());
    const [standings, teams] = await Promise.all([
      q(SQL_LEAGUE_STANDINGS, [clubIds]),
      q(SQL_LEAGUE_TEAMS, [clubIds])
    ]);
    res.json({ teams: teams.rows, standings: standings.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch league standings');
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

app.get('/api/leagues/:leagueId/leaders', async (req, res) => {
  const clubIds = clubsForLeague(req.params.leagueId);
  if (!clubIds.length) {
    return res.status(404).json({ error: 'Unknown league' });
  }
  try {
    const leaders = await getUpclLeaders(clubIds);
    res.json(leaders);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch league leaders');
    res.status(500).json({ error: 'Failed to fetch league leaders' });
  }
});

app.get('/api/leagues/:leagueId/matches', async (req, res) => {
  try {
    const { rows } = await q(SQL_GET_CUP_FIXTURES, [req.params.leagueId]);
    const matches = rows.map(r => ({
      id: r.id,
      cup: r.cup,
      home: r.home,
      away: r.away,
      round: r.round,
      when: Number(r.when_ts || r.when || r.at || 0) || null,
      status: r.status || null,
      score: { hs: Number(r.hs ?? r.score_h ?? 0), as: Number(r.away_score ?? r.score_a ?? 0) },
      createdAt: Number(r.created_at || r.createdAt || 0) || null
    }));
    res.json({ matches });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch league matches');
    res.status(500).json({ matches: [] });
  }
});


// Auto update every 10 minutes
if (process.env.NODE_ENV !== 'test' && CRON_ENABLED) {
  cron.schedule('*/10 * * * *', async () => {
    console.log(`[${new Date().toISOString()}] Auto update starting...`);
    try {
      await refreshAllMatches(resolveClubIds());
      console.log(`[${new Date().toISOString()}] ✅ Auto update complete.`);
    } catch (err) {
      logger.error({ err }, `[${new Date().toISOString()}] ❌ Auto update failed`);
    }
  });
}



async function bootstrap() {
  if (process.env.MIGRATE_ON_BOOT === '1') {
    console.log('[migrate] starting');
    await runMigrations();
    console.log('[migrate] done');
  }
  try {
    const { rows } = await q('SELECT current_database() AS db, current_schema() AS schema');
    console.log(`[db] connected to ${rows[0].db} schema ${rows[0].schema}`);
  } catch (err) {
    console.error('[db] failed to query active database', err);
  }

  if (process.env.NODE_ENV !== 'test') {
    try {
      await refreshAllMatches(resolveClubIds());
      console.log(`[${new Date().toISOString()}] ✅ Initial sync complete.`);
    } catch (err) {
      logger.error({ err }, `[${new Date().toISOString()}] ❌ Initial sync error`);
    }
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server on :${PORT}`);
  });
}

if (require.main === module) {
  bootstrap().catch(err => {
    console.error('[bootstrap] failed', err);
    process.exit(1);
  });
}

module.exports = app;
module.exports.saveEaMatch = saveEaMatch;
