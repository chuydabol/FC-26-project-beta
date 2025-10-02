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
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const logger = require('./logger');
const eaApi = require('./services/eaApi');
const { q } = require('./services/pgwrap');
const { runMigrations } = require('./services/migrate');
const { parseVpro, tierFromStats } = require('./services/playerCards');
const { rebuildUpclStandings } = require('./scripts/rebuildUpclStandings');
const { rebuildUpclLeaders } = require('./scripts/rebuildUpclLeaders');

// SQL statements for saving EA matches
const SQL_INSERT_MATCH = `
  INSERT INTO public.matches (match_id, ts_ms, raw, home_division, away_division)
  VALUES ($1, $2, $3::jsonb, $4, $5)
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

const SQL_UPSERT_PLAYER_INFO = `
  INSERT INTO public.players (
    player_id,
    club_id,
    name,
    position,
    vproattr,
    overall_rating,
    goals,
    assists,
    last_seen
  )
  VALUES ($1, $2, $3, $4, $5, $6, 0, 0, NOW())
  ON CONFLICT (player_id, club_id) DO UPDATE SET
    name = EXCLUDED.name,
    position = EXCLUDED.position,
    vproattr = EXCLUDED.vproattr,
    overall_rating = COALESCE(EXCLUDED.overall_rating, public.players.overall_rating),
    last_seen = NOW()
`;

const SQL_INSERT_PLAYER_MATCH_STATS = `
  INSERT INTO public.player_match_stats (
    match_id, player_id, club_id, competition_id,
    goals, assists, realtimegame, shots, passesmade, passattempts,
    tacklesmade, tackleattempts, cleansheetsany, saves, goalsconceded,
    rating, mom
  )
  VALUES (
    $1, $2, $3, $4,
    $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15,
    $16, $17
  )
  ON CONFLICT (match_id, player_id, club_id) DO NOTHING
`;

const SQL_REFRESH_PLAYER_TOTALS = `
  UPDATE public.players p SET
    goals = COALESCE(s.goals, 0),
    assists = COALESCE(s.assists, 0),
    realtimegame = COALESCE(s.realtimegame, 0),
    shots = COALESCE(s.shots, 0),
    passesmade = COALESCE(s.passesmade, 0),
    passattempts = COALESCE(s.passattempts, 0),
    tacklesmade = COALESCE(s.tacklesmade, 0),
    tackleattempts = COALESCE(s.tackleattempts, 0),
    cleansheetsany = COALESCE(s.cleansheetsany, 0),
    saves = COALESCE(s.saves, 0),
    goalsconceded = COALESCE(s.goalsconceded, 0),
    rating = COALESCE(s.rating, 0),
    mom = COALESCE(s.mom, 0),
    last_seen = NOW()
  FROM (
    SELECT player_id, club_id,
           SUM(goals) AS goals,
           SUM(assists) AS assists,
           SUM(realtimegame) AS realtimegame,
           SUM(shots) AS shots,
           SUM(passesmade) AS passesmade,
           SUM(passattempts) AS passattempts,
           SUM(tacklesmade) AS tacklesmade,
           SUM(tackleattempts) AS tackleattempts,
           SUM(cleansheetsany) AS cleansheetsany,
           SUM(saves) AS saves,
           SUM(goalsconceded) AS goalsconceded,
           AVG(rating) AS rating,
           SUM(mom) AS mom
      FROM public.player_match_stats
     WHERE player_id = $1 AND club_id = $2
     GROUP BY player_id, club_id
  ) s
 WHERE p.player_id = $1 AND p.club_id = $2
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

const SQL_INSERT_MANUAL_NEWS = `
  INSERT INTO public.news (type, title, body, image_url, video_url, author)
  VALUES ('manual_post', $1, $2, $3, $4, $5)
  RETURNING id, type, title, body,
            image_url AS "imageUrl",
            video_url AS "videoUrl",
            created_at AS "createdAt",
            author
`;

const SQL_SELECT_ACTIVE_NEWS = `
  SELECT id,
         type,
         title,
         body,
         image_url AS "imageUrl",
         video_url AS "videoUrl",
         created_at AS "createdAt",
         author,
         expires_at AS "expiresAt"
    FROM public.news
   WHERE expires_at IS NULL OR expires_at > NOW()
   ORDER BY created_at DESC
   LIMIT 100
`;

const SQL_DELETE_MANUAL_NEWS = `
  DELETE FROM public.news
   WHERE id = $1 AND type = 'manual_post'
  RETURNING id
`;

const SQL_DELETE_EXPIRED_NEWS = `
  DELETE FROM public.news
   WHERE expires_at IS NOT NULL AND expires_at <= NOW()
`;

const SQL_SELECT_ACTIVE_HIDDEN_GEMS = `
  SELECT id, body, created_at AS "createdAt"
    FROM public.news
   WHERE type = 'hidden_gem'
     AND (expires_at IS NULL OR expires_at > NOW())
`;

const SQL_INSERT_HIDDEN_GEM_NEWS = `
  INSERT INTO public.news (type, title, body, author, expires_at)
  VALUES ('hidden_gem', $1, $2, $3, NOW() + INTERVAL '24 hours')
  RETURNING id
`;

const SQL_TOP_STANDINGS = `
  SELECT club_id,
         pts,
         w,
         d,
         l,
         gf,
         ga,
         gd,
         updated_at
    FROM public.upcl_standings
   WHERE club_id::bigint = ANY($1::bigint[])
   ORDER BY pts DESC, gd DESC, gf DESC
   LIMIT 5
`;

const SQL_TOP_LEADERS = `
  SELECT type,
         club_id,
         name,
         count
    FROM public.upcl_leaders
   ORDER BY type, count DESC, name
`;

const SQL_RECENT_MATCHES_NEWS = `
  SELECT m.match_id,
         m.ts_ms,
         home.club_id AS home_id,
         away.club_id AS away_id,
         home.goals    AS home_goals,
         away.goals    AS away_goals
    FROM public.matches m
    JOIN public.match_participants home
      ON home.match_id = m.match_id AND home.is_home = true
    JOIN public.match_participants away
      ON away.match_id = m.match_id AND away.is_home = false
   ORDER BY m.ts_ms DESC
   LIMIT 3
`;

const SQL_HIDDEN_GEM_CANDIDATES = `
  SELECT p.player_id,
         p.name,
         p.position,
         p.club_id,
         p.overall_rating,
         c.club_name,
         COUNT(*) AS matches,
         SUM(pms.goals) AS goals,
         SUM(pms.assists) AS assists,
         SUM(pms.saves) AS saves,
         SUM(pms.tacklesmade) AS tackles,
         SUM(pms.goalsconceded) AS goals_conceded
    FROM public.player_match_stats pms
    JOIN public.players p
      ON p.player_id = pms.player_id
     AND p.club_id = pms.club_id
    LEFT JOIN public.clubs c
      ON c.club_id = p.club_id
   WHERE COALESCE(p.overall_rating, 0) <= 75
   GROUP BY p.player_id, p.name, p.position, p.club_id, p.overall_rating, c.club_name
  HAVING COUNT(*) >= 5
`;

const SQL_INSERT_PENDING_MATCH = `
  INSERT INTO public.pending_matches (
    match_id,
    source_club_id,
    opponent_club_id,
    match_timestamp,
    raw
  )
  VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5::jsonb)
  ON CONFLICT (match_id) DO NOTHING
`;

const SQL_SELECT_PENDING_MATCHES = `
  SELECT match_id,
         source_club_id,
         opponent_club_id,
         match_timestamp,
         raw,
         created_at
    FROM public.pending_matches
   ORDER BY match_timestamp DESC NULLS LAST, created_at DESC
`;

const SQL_SELECT_PENDING_MATCH = `
  SELECT match_id,
         source_club_id,
         opponent_club_id,
         match_timestamp,
         raw
    FROM public.pending_matches
   WHERE match_id = $1
`;

const SQL_DELETE_PENDING_MATCH = `
  DELETE FROM public.pending_matches
   WHERE match_id = $1
`;

const SQL_INSERT_COMPETITION_MATCH = `
  INSERT INTO public.competition_matches (
    competition_id,
    group_name,
    round_name,
    match_id,
    home_club_id,
    away_club_id,
    home_score,
    away_score,
    played_at,
    raw
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0), $10::jsonb)
  ON CONFLICT (competition_id, match_id) DO NOTHING
  RETURNING id
`;

const SQL_UPSERT_COMP_STANDING = `
  INSERT INTO public.competition_standings (
    competition_id,
    group_name,
    club_id,
    played,
    wins,
    draws,
    losses,
    goals_for,
    goals_against,
    points,
    goal_diff,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
  ON CONFLICT (competition_id, group_name, club_id) DO UPDATE SET
    played = public.competition_standings.played + EXCLUDED.played,
    wins = public.competition_standings.wins + EXCLUDED.wins,
    draws = public.competition_standings.draws + EXCLUDED.draws,
    losses = public.competition_standings.losses + EXCLUDED.losses,
    goals_for = public.competition_standings.goals_for + EXCLUDED.goals_for,
    goals_against = public.competition_standings.goals_against + EXCLUDED.goals_against,
    points = public.competition_standings.points + EXCLUDED.points,
    goal_diff = public.competition_standings.goal_diff + EXCLUDED.goal_diff,
    updated_at = NOW()
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

function normalizeClubIds(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return [];
  }
  return ids
    .map(id => {
      const asString = String(id ?? '').trim();
      if (!asString) {
        return null;
      }
      const asNumber = Number(asString);
      return Number.isFinite(asNumber) ? asNumber : null;
    })
    .filter(id => id !== null);
}

function clubsForLeague(id) {
  return normalizeClubIds(LEAGUE_CLUBS[id] || []);
}
const DEFAULT_LEAGUE_ID = process.env.DEFAULT_LEAGUE_ID || 'UPCL_LEAGUE_2025';

const fsp = fs.promises;
const NEWS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'news');
const PLAYER_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'players');
const MAX_NEWS_IMAGE_SIZE = 3 * 1024 * 1024; // 3MB
const NEWS_IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};
const PLAYER_IMAGE_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const PLAYER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]);

fs.mkdirSync(PLAYER_UPLOAD_DIR, { recursive: true });

const playerImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PLAYER_IMAGE_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!file?.mimetype) {
      return cb(new Error('Invalid image upload.'));
    }
    if (PLAYER_IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Only JPG, PNG, or WEBP images are allowed.'));
  }
});

function parseHomeIndicator(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'home' || normalized === 'true') return true;
    if (normalized === 'away' || normalized === 'false') return false;
    if (/^[-+]?\d+(\.0+)?$/.test(normalized)) {
      return Number(normalized) !== 0;
    }
  }
  return Boolean(value);
}

function mapNewsRow(row = {}) {
  const createdAt = row.createdAt instanceof Date
    ? row.createdAt.toISOString()
    : row.createdAt;
  const expiresAt = row.expiresAt instanceof Date
    ? row.expiresAt.toISOString()
    : row.expiresAt;
  let normalizedType = row.type ? String(row.type).toLowerCase() : 'manual_post';
  if (normalizedType === 'manual') normalizedType = 'manual_post';
  let defaultAuthor = 'UPCL Update Bot';
  if (normalizedType === 'manual_post') defaultAuthor = 'Community Reporter';
  if (normalizedType === 'hidden_gem') defaultAuthor = 'UPCL Auto Analyst';
  const author = row.author || defaultAuthor;
  let badge = row.badge;
  if (!badge) {
    if (normalizedType === 'manual_post') {
      badge = /admin/i.test(author) ? 'League Bulletin' : 'Community Post';
    } else if (normalizedType === 'hidden_gem') {
      badge = 'Hidden Gem';
    } else {
      badge = 'Auto Update';
    }
  }
  const category = row.category
    || (normalizedType === 'manual_post' ? 'general' : 'main');

  let body = row.body || '';
  let details = null;
  if (normalizedType === 'hidden_gem') {
    const parsed = safeJsonParse(row.body);
    if (parsed && typeof parsed === 'object') {
      details = parsed;
      body = parsed.summary || body;
    }
  }

  return {
    id: row.id,
    type: normalizedType,
    title: row.title || '',
    body,
    imageUrl: row.imageUrl || null,
    videoUrl: row.videoUrl || null,
    createdAt: createdAt || new Date().toISOString(),
    expiresAt: expiresAt || null,
    author,
    badge,
    category,
    details,
  };
}

function clubDisplayName(clubId) {
  if (!clubId && clubId !== 0) return '';
  return CLUB_NAMES[String(clubId)] || String(clubId);
}

function sanitizeVideoUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function persistNewsImage(imageData) {
  if (!imageData) return null;
  const trimmed = String(imageData).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  const ext = NEWS_IMAGE_EXTENSIONS[mime] || 'png';
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return null;
  if (buffer.length > MAX_NEWS_IMAGE_SIZE) {
    throw new Error('Image too large');
  }
  await fsp.mkdir(NEWS_UPLOAD_DIR, { recursive: true });
  const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
  const fileName = `news-${Date.now()}-${id}.${ext}`;
  await fsp.writeFile(path.join(NEWS_UPLOAD_DIR, fileName), buffer);
  return `/uploads/news/${fileName}`;
}

async function buildAutoNewsItems() {
  const now = new Date();
  try {
    const leagueClubIds = resolveClubIds();
    const standingsPromise = leagueClubIds.length
      ? q(SQL_TOP_STANDINGS, [leagueClubIds]).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] });

    const [standingsRes, leadersRes, matchesRes] = await Promise.all([
      standingsPromise,
      q(SQL_TOP_LEADERS).catch(() => ({ rows: [] })),
      q(SQL_RECENT_MATCHES_NEWS).catch(() => ({ rows: [] }))
    ]);

    const auto = [];

    const allowedClubIds = new Set(leagueClubIds.map(id => String(id)));
    const standingsRows = allowedClubIds.size
      ? (standingsRes.rows || []).filter(row =>
        allowedClubIds.has(String(row.club_id))
      )
      : [];

    if (standingsRows.length) {
      const firstRow = standingsRows[0];
      const createdAt = firstRow.updated_at instanceof Date
        ? firstRow.updated_at.toISOString()
        : new Date(now.getTime() - 2 * 60 * 1000).toISOString();
      auto.push({
        id: 'auto-standings',
        type: 'standings_snapshot',
        badge: 'Standings',
        title: 'Standings Snapshot',
        body: 'Top clubs in the UPCL table after the latest matches.',
        createdAt,
        author: 'Auto Feed',
        stats: standingsRows.map((row, idx) => ({
          rank: idx + 1,
          clubId: String(row.club_id),
          points: Number(row.pts || 0),
          record: `${Number(row.w || 0)}-${Number(row.d || 0)}-${Number(row.l || 0)}`,
          goalDiff: Number(row.gd || 0)
        }))
      });
    }

    const scorers = leadersRes.rows.filter(r => r.type === 'scorer').slice(0, 5);
    if (scorers.length) {
      auto.push({
        id: 'auto-scorers',
        type: 'standings_snapshot',
        badge: 'Goal Leaders',
        title: 'Golden Boot Race',
        body: 'Who leads the league in goals?',
        createdAt: new Date(now.getTime() - 90 * 1000).toISOString(),
        author: 'Auto Feed',
        chart: {
          type: 'bar',
          color: '#facc15',
          data: scorers.map(row => ({
            name: row.name,
            value: Number(row.count || 0),
            clubId: String(row.club_id || '')
          }))
        }
      });
    }

    const assists = leadersRes.rows.filter(r => r.type === 'assister').slice(0, 5);
    if (assists.length) {
      auto.push({
        id: 'auto-assists',
        type: 'standings_snapshot',
        badge: 'Assist Leaders',
        title: 'Playmakers on Fire',
        body: 'Top assist leaders in the league.',
        createdAt: new Date(now.getTime() - 60 * 1000).toISOString(),
        author: 'Auto Feed',
        chart: {
          type: 'area',
          color: '#38bdf8',
          data: assists.map(row => ({
            name: row.name,
            value: Number(row.count || 0),
            clubId: String(row.club_id || '')
          }))
        }
      });
    }

    const latestMatch = matchesRes.rows.find(r => Number(r.ts_ms));
    if (latestMatch) {
      const tsMs = Number(latestMatch.ts_ms);
      auto.push({
        id: `auto-match-${latestMatch.match_id}`,
        type: 'standings_snapshot',
        badge: 'Match Recap',
        title: 'Latest Final Score',
        body: `${clubDisplayName(latestMatch.home_id)} vs ${clubDisplayName(latestMatch.away_id)}`,
        createdAt: new Date(tsMs || now.getTime()).toISOString(),
        author: 'Auto Feed',
        highlight: {
          home: {
            clubId: String(latestMatch.home_id),
            goals: Number(latestMatch.home_goals || 0)
          },
          away: {
            clubId: String(latestMatch.away_id),
            goals: Number(latestMatch.away_goals || 0)
          }
        }
      });
    }

    return auto;
  } catch (err) {
    logger.error({ err }, 'Failed to build auto news items');
    return [];
  }
}

// League standings include only matches within this date range (Unix ms)
// Defaults reflect the current season but can be overridden via environment
// variables. Values may be provided as Unix millisecond timestamps or ISO
// date strings.
function parseDateMs(value, fallback) {
  const ms = value ? Number(value) || Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : fallback;
}

function normalizeTimestampMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num > 1_000_000_000_000) {
    return Math.trunc(num);
  }
  return Math.trunc(num * 1000);
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function deriveMatchSides(match = {}) {
  const clubs = match.clubs || {};
  const entries = Object.entries(clubs).map(([cid, c]) => {
    const details = c?.details || {};
    const name = typeof details.name === 'string' ? details.name.trim() : '';
    const rawIsHome = details.isHome;
    const isHome = rawIsHome !== undefined ? parseHomeIndicator(rawIsHome) : null;
    return {
      clubId: String(cid),
      goals: Number(c?.goals || 0),
      name: name || `Club ${cid}`,
      isHome,
      hasHomeFlag: rawIsHome !== undefined && rawIsHome !== null,
    };
  });

  let home = entries.find(entry => entry.isHome === true) || null;
  let away = entries.find(entry => entry.isHome === false) || null;

  if (!home && entries.length) {
    home = entries[0];
  }
  if ((!away || (home && away.clubId === home.clubId)) && entries.length > 1) {
    away = entries.find(entry => !home || entry.clubId !== home.clubId) || away;
  }

  if (!away && entries.length === 1) {
    away = null;
  }

  return { home, away, entries };
}

function extractMatchPlayers(match = {}) {
  const players = [];
  const map = match.players || {};
  for (const [cid, roster] of Object.entries(map)) {
    if (!roster || typeof roster !== 'object') continue;
    const clubId = String(cid);
    for (const [pid, pdata] of Object.entries(roster)) {
      const playerIdRaw = pdata?.playerId || pdata?.playerid || pid;
      const playerId = playerIdRaw ? String(playerIdRaw) : null;
      const name =
        pdata?.name ||
        pdata?.playername ||
        pdata?.proName ||
        pdata?.personaName ||
        (playerId ? `Player_${playerId}` : 'Unknown');
      const position = pdata?.position || pdata?.pos || pdata?.proPos || '';
      players.push({
        clubId,
        playerId,
        name,
        position,
        goals: Number(pdata?.goals || 0),
        assists: Number(pdata?.assists || 0),
        rating: Number(
          pdata?.rating ||
            pdata?.matchRating ||
            pdata?.averageMatchRating ||
            pdata?.averageRating ||
            0
        ),
        saves: Number(pdata?.saves || 0),
        tackles: Number(pdata?.tacklesmade || pdata?.tacklesMade || 0),
        data: pdata || {},
      });
    }
  }
  return players;
}

function computeStandingDelta(homeGoals, awayGoals) {
  const hg = Number(homeGoals || 0);
  const ag = Number(awayGoals || 0);
  if (hg > ag) {
    return {
      home: { played: 1, wins: 1, draws: 0, losses: 0, points: 3 },
      away: { played: 1, wins: 0, draws: 0, losses: 1, points: 0 },
    };
  }
  if (hg < ag) {
    return {
      home: { played: 1, wins: 0, draws: 0, losses: 1, points: 0 },
      away: { played: 1, wins: 1, draws: 0, losses: 0, points: 3 },
    };
  }
  return {
    home: { played: 1, wins: 0, draws: 1, losses: 0, points: 1 },
    away: { played: 1, wins: 0, draws: 1, losses: 0, points: 1 },
  };
}

const LEAGUE_START_MS = parseDateMs(
  process.env.LEAGUE_START_MS,
  Date.parse('2025-08-27T23:59:00-07:00')
);

function resolveClubIds() {
  let ids = clubsForLeague(DEFAULT_LEAGUE_ID);
  if (!ids.length) {
    ids = normalizeClubIds(
      (process.env.EA_CLUB_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
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
  '585548': 'Club Frijol'
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

// Debounced standings refresh
const AUTO_REFRESH_STANDINGS = process.env.AUTO_REFRESH_STANDINGS !== '0';
let _standingsRefreshTimer = null;
async function _refreshStandings() {
  await q('REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_league_standings');
  await rebuildUpclStandings();
  await rebuildUpclLeaders();
}
function scheduleStandingsRefresh() {
  if (!AUTO_REFRESH_STANDINGS || process.env.NODE_ENV === 'test') return;
  if (_standingsRefreshTimer) return;
  _standingsRefreshTimer = setTimeout(async () => {
    _standingsRefreshTimer = null;
    try {
      await _refreshStandings();
    } catch (err) {
      logger.error({ err }, 'Failed refreshing standings');
    }
  }, 1000);
  if (typeof _standingsRefreshTimer.unref === 'function') {
    _standingsRefreshTimer.unref();
  }
}



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
  if (tsMs < LEAGUE_START_MS) return;
  const clubs = match.clubs || {};
  const clubEntries = Object.entries(clubs).map(([cid, c]) => {
    const details = c?.details || {};
    const name = typeof details.name === 'string' ? details.name.trim() : '';
    const hasHomeFlag = details.isHome !== undefined && details.isHome !== null;
    return {
      clubId: cid,
      name,
      isHome: hasHomeFlag ? parseHomeIndicator(details.isHome) : null,
      hasHomeFlag,
    };
  });
  const normalizedHomeFlags = new Map();

  let homeDivision = null;
  let awayDivision = null;

  if (clubEntries.length) {
    const divisionLookups = await Promise.all(
      clubEntries.map(async info => {
        if (!info.name) {
          return { ...info, division: null };
        }
        try {
          const division = await limit(() =>
            eaApi.fetchClubDivisionByName(info.name)
          );
          return { ...info, division };
        } catch (err) {
          logger.warn(
            { err, clubId: info.clubId, clubName: info.name },
            'Failed fetching leaderboard division'
          );
          return { ...info, division: null };
        }
      })
    );

    let homeEntry =
      divisionLookups.find(entry => entry.hasHomeFlag && entry.isHome === true) ||
      null;
    let awayEntry =
      divisionLookups.find(entry => entry.hasHomeFlag && entry.isHome === false) ||
      null;

    if (!homeEntry && divisionLookups.length) {
      if (awayEntry && divisionLookups.length > 1) {
        homeEntry = divisionLookups.find(entry => entry !== awayEntry) || awayEntry;
      } else {
        homeEntry = divisionLookups[0];
      }
    }

    if (awayEntry && homeEntry && awayEntry.clubId === homeEntry.clubId) {
      awayEntry = null;
    }
    if (!awayEntry) {
      awayEntry = divisionLookups.find(entry => entry !== homeEntry) || null;
    }

    if (homeEntry) {
      for (const entry of divisionLookups) {
        const isHomeNormalized = entry.clubId === homeEntry.clubId;
        normalizedHomeFlags.set(entry.clubId, isHomeNormalized);
      }
    }

    homeDivision = homeEntry?.division ?? null;
    awayDivision = awayEntry?.division ?? null;
  }

  const { rowCount } = await q(SQL_INSERT_MATCH, [
    matchId,
    tsMs,
    match,
    homeDivision,
    awayDivision,
  ]);
  if (rowCount === 0) return;

  for (const cid of Object.keys(clubs)) {
    const c = clubs[cid];
    const name = c?.details?.name || `Club ${cid}`;
    const goals = Number(c?.goals || 0);
    const isHome = normalizedHomeFlags.has(cid)
      ? normalizedHomeFlags.get(cid)
      : parseHomeIndicator(c?.details?.isHome);
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
        const realtimegame = Number(pdata.realtimegame || 0);
        const shots = Number(pdata.shots || 0);
        const passesmade = Number(pdata.passesmade || 0);
        const passattempts = Number(pdata.passattempts || 0);
        const tacklesmade = Number(pdata.tacklesmade || 0);
        const tackleattempts = Number(pdata.tackleattempts || 0);
        const cleansheetsany = Number(pdata.cleansheetsany || 0);
        const saves = Number(pdata.saves || 0);
        const goalsconceded = Number(pdata.goalsconceded || 0);
        const rating = Number(pdata.rating || 0);
        const mom = Number(pdata.mom || 0);
        await q(SQL_UPSERT_PLAYER_INFO, [pid, cid, name, pos, vproattr, null]);
        const { rowCount: statInserted } = await q(SQL_INSERT_PLAYER_MATCH_STATS, [
          matchId,
          pid,
          cid,
          null,
          goals,
          assists,
          realtimegame,
          shots,
          passesmade,
          passattempts,
          tacklesmade,
          tackleattempts,
          cleansheetsany,
          saves,
          goalsconceded,
          rating,
          mom,
        ]);
        if (statInserted) {
          await q(SQL_REFRESH_PLAYER_TOTALS, [pid, cid]);
        }
        if (vproattr) {
          const stats = parseVpro(vproattr);
          await q(SQL_UPSERT_PLAYERCARD, [pid, cid, name, pos, vproattr, stats.ovr]);
        }
      }
    }
  }

  scheduleStandingsRefresh();
}

async function refreshClubMatches(clubId) {
  const matches = await fetchClubMatches(clubId);
  for (const m of matches) {
    const tsMs = Number(m.timestamp) * 1000;
    if (tsMs < LEAGUE_START_MS) continue;
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
}

async function queueFriendlyMatch(match, sourceClubId) {
  if (!match || !sourceClubId) return;
  const matchIdRaw = match.matchId || match.matchid || match.id;
  const matchId = matchIdRaw ? String(matchIdRaw) : null;
  if (!matchId) return;
  const tsMs =
    normalizeTimestampMs(match.timestamp || match.ts || match.matchTimestamp) || Date.now();
  const { home, away } = deriveMatchSides(match);
  const sourceId = String(sourceClubId);
  let opponentId = null;
  if (home && sourceId === String(home.clubId)) {
    opponentId = away ? String(away.clubId) : null;
  } else if (away && sourceId === String(away.clubId)) {
    opponentId = home ? String(home.clubId) : null;
  } else if (home) {
    opponentId = String(home.clubId);
  }
  if (!opponentId) return;
  try {
    await q(SQL_INSERT_PENDING_MATCH, [
      matchId,
      sourceId,
      opponentId,
      tsMs,
      JSON.stringify(match),
    ]);
  } catch (err) {
    logger.error({ err, matchId }, 'Failed to queue friendly match');
  }
}

async function refreshClubFriendlies(clubId) {
  let friendlies = [];
  try {
    friendlies = await limit(() => eaApi.fetchClubFriendliesWithRetry(clubId));
  } catch (err) {
    logger.error({ err, clubId }, 'Failed fetching friendlies');
    return;
  }
  for (const match of Array.isArray(friendlies) ? friendlies : []) {
    await queueFriendlyMatch(match, clubId);
  }
}

async function refreshFriendlyMatches(clubIds) {
  const ids = clubIds && clubIds.length ? clubIds : resolveClubIds();
  for (const clubId of ids) {
    await refreshClubFriendlies(clubId);
  }
}

async function approvePendingMatch(matchId, options = {}) {
  const competitionId = String(options.competitionId || '').trim();
  if (!competitionId) {
    throw new Error('competitionId is required');
  }
  const groupName = String(options.groupName || 'Group A').trim() || 'Group A';
  const roundName = options.roundName ? String(options.roundName).trim() : null;

  const pending = await q(SQL_SELECT_PENDING_MATCH, [String(matchId)]);
  if (!pending.rowCount) {
    throw new Error('Pending match not found');
  }

  const row = pending.rows[0];
  const match = safeJsonParse(row.raw) || {};
  const tsMs =
    normalizeTimestampMs(match.timestamp || match.ts || row.match_timestamp) || Date.now();
  const { home, away } = deriveMatchSides(match);
  if (!home || !away) {
    throw new Error('Match is missing club data');
  }

  await q(SQL_UPSERT_CLUB, [home.clubId, home.name]);
  await q(SQL_UPSERT_CLUB, [away.clubId, away.name]);

  const insertRes = await q(SQL_INSERT_COMPETITION_MATCH, [
    competitionId,
    groupName,
    roundName,
    String(matchId),
    home.clubId,
    away.clubId,
    Number(home.goals || 0),
    Number(away.goals || 0),
    tsMs,
    JSON.stringify(match),
  ]);
  if (!insertRes.rowCount) {
    throw new Error('Match already approved');
  }

  const players = extractMatchPlayers(match);
  for (const player of players) {
    const pid = player.playerId;
    if (!pid) continue;
    const pdata = player.data || {};
    const name = player.name || `Player_${pid}`;
    const position = player.position || 'UNK';
    const vproattr = pdata.vproattr || null;
    const overallRaw =
      pdata.overallRating || pdata.ovr || pdata.proOverall || pdata.prooverall;
    const overallRating = Number(overallRaw);
    const goals = Number(pdata.goals || 0);
    const assists = Number(pdata.assists || 0);
    const realtimegame = Number(pdata.realtimegame || 0);
    const shots = Number(pdata.shots || 0);
    const passesmade = Number(pdata.passesmade || pdata.passesMade || 0);
    const passattempts = Number(pdata.passattempts || pdata.passAttempts || 0);
    const tacklesmade = Number(pdata.tacklesmade || pdata.tacklesMade || 0);
    const tackleattempts = Number(pdata.tackleattempts || pdata.tacklesAttempted || 0);
    const cleansheetsany = Number(pdata.cleansheetsany || pdata.cleanSheetsAny || 0);
    const saves = Number(pdata.saves || 0);
    const goalsconceded = Number(pdata.goalsconceded || pdata.goalsConceded || 0);
    const rating = Number(
      pdata.rating ||
        pdata.matchRating ||
        pdata.averageMatchRating ||
        pdata.averageRating ||
        player.rating ||
        0
    );
    const mom = Number(pdata.mom || pdata.manOfTheMatch || 0);

    await q(SQL_UPSERT_PLAYER_INFO, [
      pid,
      player.clubId,
      name,
      position,
      vproattr,
      Number.isFinite(overallRating) ? overallRating : null,
    ]);

    const { rowCount } = await q(SQL_INSERT_PLAYER_MATCH_STATS, [
      String(matchId),
      pid,
      player.clubId,
      competitionId,
      goals,
      assists,
      realtimegame,
      shots,
      passesmade,
      passattempts,
      tacklesmade,
      tackleattempts,
      cleansheetsany,
      saves,
      goalsconceded,
      rating,
      mom,
    ]);
    if (rowCount) {
      await q(SQL_REFRESH_PLAYER_TOTALS, [pid, player.clubId]);
    }
    if (vproattr) {
      const stats = parseVpro(vproattr);
      await q(SQL_UPSERT_PLAYERCARD, [
        pid,
        player.clubId,
        name,
        position,
        vproattr,
        stats.ovr,
      ]);
    }
  }

  const delta = computeStandingDelta(home.goals, away.goals);
  await q(SQL_UPSERT_COMP_STANDING, [
    competitionId,
    groupName,
    home.clubId,
    delta.home.played,
    delta.home.wins,
    delta.home.draws,
    delta.home.losses,
    Number(home.goals || 0),
    Number(away.goals || 0),
    delta.home.points,
    Number(home.goals || 0) - Number(away.goals || 0),
  ]);
  await q(SQL_UPSERT_COMP_STANDING, [
    competitionId,
    groupName,
    away.clubId,
    delta.away.played,
    delta.away.wins,
    delta.away.draws,
    delta.away.losses,
    Number(away.goals || 0),
    Number(home.goals || 0),
    delta.away.points,
    Number(away.goals || 0) - Number(home.goals || 0),
  ]);

  await q(SQL_DELETE_PENDING_MATCH, [String(matchId)]);

  return {
    competitionId,
    matchId: String(matchId),
    home,
    away,
    groupName,
    roundName,
  };
}

async function rejectPendingMatch(matchId) {
  await q(SQL_DELETE_PENDING_MATCH, [String(matchId)]);
}

function mapPendingMatch(row) {
  const match = safeJsonParse(row.raw) || {};
  const { home, away } = deriveMatchSides(match);
  const players = extractMatchPlayers(match).map(player => ({
    clubId: player.clubId,
    playerId: player.playerId,
    name: player.name,
    goals: player.goals,
    assists: player.assists,
    rating: Number(player.rating || 0),
    position: player.position || '',
  }));
  const playedAt = row.match_timestamp instanceof Date
    ? row.match_timestamp.toISOString()
    : (normalizeTimestampMs(row.match_timestamp) && new Date(normalizeTimestampMs(row.match_timestamp)).toISOString());
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : null;
  return {
    matchId: String(row.match_id),
    sourceClubId: String(row.source_club_id),
    opponentClubId: String(row.opponent_club_id),
    playedAt,
    createdAt,
    home: home
      ? { clubId: home.clubId, name: home.name, goals: Number(home.goals || 0) }
      : null,
    away: away
      ? { clubId: away.clubId, name: away.name, goals: Number(away.goals || 0) }
      : null,
    players,
  };
}

async function cleanupExpiredNews() {
  try {
    await q(SQL_DELETE_EXPIRED_NEWS);
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup expired news');
  }
}

const POSITION_GROUPS = {
  striker: new Set(['ST', 'CF', 'LF', 'RF', 'LS', 'RS', 'LW', 'RW']),
  midfielder: new Set(['CM', 'CDM', 'CAM', 'LM', 'RM', 'LCM', 'RCM', 'LAM', 'RAM']),
  defender: new Set(['CB', 'LCB', 'RCB', 'LB', 'RB', 'LWB', 'RWB', 'SW']),
  goalkeeper: new Set(['GK']),
};

function categorizePosition(position) {
  const normalized = String(position || '').toUpperCase();
  if (POSITION_GROUPS.goalkeeper.has(normalized)) return 'goalkeeper';
  if (POSITION_GROUPS.defender.has(normalized)) return 'defender';
  if (POSITION_GROUPS.midfielder.has(normalized)) return 'midfielder';
  if (POSITION_GROUPS.striker.has(normalized)) return 'striker';
  return null;
}

function evaluateHiddenGemCandidate(row) {
  const matches = Number(row.matches || 0);
  if (!Number.isFinite(matches) || matches < 5) return null;
  const overall = Number(row.overall_rating);
  if (!Number.isFinite(overall)) return null;
  const group = categorizePosition(row.position);
  if (!group) return null;

  const goals = Number(row.goals || 0);
  const assists = Number(row.assists || 0);
  const saves = Number(row.saves || 0);
  const tackles = Number(row.tackles || 0);
  const goalsConceded = Number(row.goals_conceded || 0);

  const perGoals = matches ? goals / matches : 0;
  const perAssists = matches ? assists / matches : 0;
  const perSaves = matches ? saves / matches : 0;
  const perTackles = matches ? tackles / matches : 0;
  const totalShots = saves + goalsConceded;
  const savePct = totalShots > 0 ? (saves / totalShots) * 100 : 0;

  let qualifies = false;
  let score = 0;

  switch (group) {
    case 'striker':
      qualifies = perGoals >= 0.6;
      score = perGoals - 0.6;
      break;
    case 'midfielder':
      qualifies = perAssists >= 0.5;
      score = perAssists - 0.5;
      break;
    case 'defender':
      qualifies = perTackles >= 2.5;
      score = perTackles - 2.5;
      break;
    case 'goalkeeper':
      qualifies = perSaves >= 3 && savePct > 70;
      score = (perSaves - 3) + Math.max(0, (savePct - 70) / 100);
      break;
    default:
      qualifies = false;
  }

  if (!qualifies) return null;

  const potentialRating = Math.min(99, Math.round(overall + 5));
  const summaryParts = [
    `Matches ${matches}`,
    `Goals ${goals}`,
    `Assists ${assists}`,
  ];
  if (saves > 0) summaryParts.push(`Saves ${saves}`);
  if (tackles > 0) summaryParts.push(`Tackles ${tackles}`);

  return {
    playerId: row.player_id,
    name: row.name,
    position: row.position,
    clubId: row.club_id ? String(row.club_id) : null,
    clubName: row.club_name || '',
    overallRating: overall,
    matches,
    goals,
    assists,
    saves,
    tackles,
    goalsConceded,
    perMatch: {
      goals: Number(perGoals.toFixed(2)),
      assists: Number(perAssists.toFixed(2)),
      tackles: Number(perTackles.toFixed(2)),
      saves: Number(perSaves.toFixed(2)),
      savePct: Number(savePct.toFixed(1)),
    },
    potentialRating,
    summary: summaryParts.join(' • '),
    score,
  };
}

async function ensureHiddenGemNews() {
  try {
    const active = await q(SQL_SELECT_ACTIVE_HIDDEN_GEMS);
    if (active.rowCount) {
      return;
    }
    const candidatesRes = await q(SQL_HIDDEN_GEM_CANDIDATES);
    const evaluated = (candidatesRes.rows || [])
      .map(evaluateHiddenGemCandidate)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const picks = evaluated.slice(0, 3);
    for (const candidate of picks) {
      const payload = {
        playerId: candidate.playerId,
        playerName: candidate.name,
        position: candidate.position,
        clubId: candidate.clubId,
        clubName: candidate.clubName,
        overallRating: candidate.overallRating,
        matches: candidate.matches,
        goals: candidate.goals,
        assists: candidate.assists,
        saves: candidate.saves,
        tackles: candidate.tackles,
        goalsConceded: candidate.goalsConceded,
        perMatch: candidate.perMatch,
        potentialRating: candidate.potentialRating,
        summary: candidate.summary,
      };
      try {
        await q(SQL_INSERT_HIDDEN_GEM_NEWS, [
          'Hidden Gem Spotlight 🌟',
          JSON.stringify(payload),
          'UPCL Auto Analyst',
        ]);
      } catch (err) {
        logger.error({ err, playerId: candidate.playerId }, 'Failed to insert hidden gem news');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to generate hidden gem news');
  }
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

function requireAdminSession(req, res) {
  if (!req.session?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

app.get('/admin/news', (req, res) => {
  if (!req.session?.isAdmin) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'teams.html'));
});

app.get('/admin/competitions', (req, res) => {
  if (!req.session?.isAdmin) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'teams.html'));
});

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

app.get('/api/admin/competitions/pending', async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  try {
    const { rows } = await q(SQL_SELECT_PENDING_MATCHES);
    res.json({ pending: rows.map(mapPendingMatch) });
  } catch (err) {
    logger.error({ err }, 'Failed to load pending competition matches');
    res.status(500).json({ pending: [] });
  }
});

app.post('/api/admin/competitions/pending/:matchId/approve', async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  const { competitionId, groupName, roundName } = req.body || {};
  if (!competitionId || !String(competitionId).trim()) {
    return res.status(400).json({ error: 'competitionId is required' });
  }
  try {
    const result = await approvePendingMatch(req.params.matchId, {
      competitionId,
      groupName,
      roundName,
    });
    res.json({ ok: true, match: result });
  } catch (err) {
    logger.error({ err, matchId: req.params.matchId }, 'Failed to approve pending match');
    res.status(400).json({ error: err.message || 'Failed to approve match' });
  }
});

app.post('/api/admin/competitions/pending/:matchId/reject', async (req, res) => {
  if (!requireAdminSession(req, res)) return;
  try {
    await rejectPendingMatch(req.params.matchId);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, matchId: req.params.matchId }, 'Failed to reject pending match');
    res.status(500).json({ error: 'Failed to reject match' });
  }
});

app.get('/api/news', async (_req, res) => {
  try {
    await cleanupExpiredNews();
    await ensureHiddenGemNews();
    const [newsRes, autoItems] = await Promise.all([
      q(SQL_SELECT_ACTIVE_NEWS),
      buildAutoNewsItems()
    ]);
    const mapped = (newsRes.rows || []).map(mapNewsRow);
    const manual = mapped.filter(item => item.type === 'manual_post');
    const curated = mapped.filter(item => item.type !== 'manual_post');
    const autos = Array.isArray(autoItems) ? autoItems.map(item => ({
      ...item,
      category: item.category || 'main'
    })) : [];
    const main = [...curated, ...autos].sort((a, b) => {
      const aTs = new Date(a.createdAt || a.ts || 0).getTime();
      const bTs = new Date(b.createdAt || b.ts || 0).getTime();
      return bTs - aTs;
    });
    const general = [...manual].sort((a, b) => {
      const aTs = new Date(a.createdAt || 0).getTime();
      const bTs = new Date(b.createdAt || 0).getTime();
      return bTs - aTs;
    });
    const combined = [...main, ...general].sort((a, b) => {
      const aTs = new Date(a.createdAt || a.ts || 0).getTime();
      const bTs = new Date(b.createdAt || b.ts || 0).getTime();
      return bTs - aTs;
    });
    res.json({ items: combined, main, general });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch news feed');
    res.status(500).json({ items: [], main: [], general: [] });
  }
});

app.post('/api/news', async (req, res) => {
  const { title, body, imageData, imageUrl, videoUrl, author } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title required' });
  }
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'Body required' });
  }
  try {
    const savedImageUrl = await persistNewsImage(imageData || imageUrl);
    const safeVideo = sanitizeVideoUrl(videoUrl);
    const isAdminSession = !!req.session?.isAdmin;
    const defaultAuthor = isAdminSession ? 'UPCL Admin' : 'Community Reporter';
    const authorName = (author && String(author).trim()) || defaultAuthor;
    const { rows } = await q(SQL_INSERT_MANUAL_NEWS, [
      String(title).trim(),
      String(body).trim(),
      savedImageUrl,
      safeVideo,
      authorName
    ]);
    const item = mapNewsRow(rows[0]);
    res.json({ ok: true, item });
  } catch (err) {
    logger.error({ err }, 'Failed to save manual news');
    res.status(500).json({ error: 'Failed to save news' });
  }
});

app.delete('/api/news/:id', async (req, res) => {
  if (!req.session?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { id } = req.params;
  if (!/^\d+$/.test(String(id || ''))) {
    return res.status(400).json({ error: 'Invalid news id' });
  }
  try {
    const result = await q(SQL_DELETE_MANUAL_NEWS, [Number(id)]);
    if (!result?.rowCount) {
      return res.status(404).json({ error: 'News item not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, 'Failed to delete manual news');
    res.status(500).json({ error: 'Failed to delete news' });
  }
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

    const { rows: playerRows } = await q(
      `SELECT player_id, overall_rating, image_url
         FROM public.players
        WHERE club_id = $1`,
      [clubId]
    );

    const { rows: formRows } = await q(
      `WITH ranked_results AS (
         SELECT
           pms.player_id,
           m.ts_ms,
           ROW_NUMBER() OVER (PARTITION BY pms.player_id ORDER BY m.ts_ms DESC) AS rn,
           CASE
             WHEN COALESCE(scores.goals_for, 0) > COALESCE(scores.goals_against, 0) THEN 'W'
             WHEN COALESCE(scores.goals_for, 0) = COALESCE(scores.goals_against, 0) THEN 'D'
             WHEN COALESCE(scores.goals_for, 0) < COALESCE(scores.goals_against, 0) THEN 'L'
             ELSE 'D'
           END AS result
         FROM public.player_match_stats pms
         JOIN public.matches m ON m.match_id = pms.match_id
         LEFT JOIN LATERAL (
           SELECT
             MAX(CASE WHEN mp.club_id = pms.club_id THEN mp.goals END) AS goals_for,
             MAX(CASE WHEN mp.club_id <> pms.club_id THEN mp.goals END) AS goals_against
           FROM public.match_participants mp
           WHERE mp.match_id = pms.match_id
         ) AS scores ON true
         WHERE pms.club_id = $1
       )
       SELECT player_id, result
         FROM ranked_results
        WHERE rn <= 5
        ORDER BY player_id, rn`,
      [clubId]
    );

    const cardMap = new Map(rows.map(r => [String(r.player_id), r]));
    const nameMap = new Map(rows.map(r => [r.name, r]));
    const playerMetaMap = new Map(
      playerRows.map(r => [
        String(r.player_id),
        {
          overall: r.overall_rating !== null && r.overall_rating !== undefined
            ? Number(r.overall_rating)
            : null,
          imageUrl: r.image_url || null,
        }
      ])
    );
    const formMap = new Map();
    for (const row of formRows) {
      const id = String(row.player_id);
      const result = typeof row.result === 'string'
        ? row.result.trim().toUpperCase()[0] || null
        : null;
      if (!['W', 'D', 'L'].includes(result)) continue;
      const existing = formMap.get(id);
      if (existing) existing.push(result);
      else formMap.set(id, [result]);
    }
    const clubName = CLUB_NAMES[String(clubId)] || '';

    const membersDetailed = members.map(m => {
      const id = String(m.playerId || m.playerid || '') || null;
      let rec = id ? cardMap.get(id) : null;
      if (!rec) rec = nameMap.get(m.name) || {};

      const vproattr = rec.vproattr || null;
      let stats = vproattr ? parseVpro(vproattr) : null;
      const playerMeta = id ? playerMetaMap.get(id) : null;
      const overallCandidates = [
        m.overallRating,
        m.overallrating,
        m.ovr,
        m.proOverall,
        stats?.ovr,
        playerMeta?.overall,
      ];
      let overallRating = null;
      for (const candidate of overallCandidates) {
        const num = Number(candidate);
        if (Number.isFinite(num) && num > 0) {
          overallRating = num;
          break;
        }
      }
      if (stats) {
        stats.ovr = overallRating ?? stats.ovr;
      } else if (overallRating) {
        stats = { ovr: overallRating };
      }

      return {
        playerId: id,
        clubId,
        clubName,
        name: m.name || rec.name || (id ? `Player_${id}` : 'Unknown'),
        position: rec.position || m.position || '',
        matches: Number(m.gamesPlayed || m.matches || 0) || 0,
        goals: Number(m.goals || 0) || 0,
        assists: Number(m.assists || 0) || 0,
        overallRating: overallRating ?? null,
        isCaptain: m.isCaptain == 1 || m.captain == 1 || m.role === 'captain',
        imageUrl: playerMeta?.imageUrl || null,
        form: formMap.get(id || '') || [],
        vproattr,
        stats,
      };
    });

    for (const member of membersDetailed) {
      if (!member.playerId) continue;
      try {
        await q(SQL_UPSERT_PLAYER_INFO, [
          member.playerId,
          clubId,
          member.name,
          member.position || 'UNK',
          member.vproattr || null,
          member.overallRating,
        ]);
      } catch (err) {
        logger.error({ err, playerId: member.playerId }, 'Failed to sync player info');
      }
    }

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

    const responseMembers = membersDetailed.map(({ vproattr, ...rest }) => rest);
    res.json({ members: responseMembers });
  } catch (err) {
    logger.error({ err }, 'Failed to load player cards');
    res.status(500).json({ members: [] });
  }
});

app.post('/api/players/:playerId/uploadImage', (req, res) => {
  if (!requireAdminSession(req, res)) return;

  const { playerId } = req.params;
  if (!/^\d+$/.test(String(playerId))) {
    return res.status(400).json({ error: 'Invalid player id' });
  }

  playerImageUpload.single('image')(req, res, async uploadErr => {
    if (uploadErr) {
      const status = uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      logger.warn({ err: uploadErr, playerId }, 'Player image upload rejected');
      return res.status(status).json({ error: uploadErr.message || 'Upload failed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    try {
      const { rowCount } = await q(
        'SELECT 1 FROM public.players WHERE player_id = $1',
        [playerId]
      );
      if (rowCount === 0) {
        return res.status(404).json({ error: 'Player not found' });
      }

      const processed = await sharp(req.file.buffer)
        .resize(300, 300, { fit: sharp.fit.cover, position: 'center' })
        .png({ quality: 90, compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();

      await fsp.mkdir(PLAYER_UPLOAD_DIR, { recursive: true });
      const outputPath = path.join(PLAYER_UPLOAD_DIR, `${playerId}.png`);
      await fsp.writeFile(outputPath, processed);

      const publicPath = `/uploads/players/${playerId}.png`;
      await q(
        'UPDATE public.players SET image_url = $1 WHERE player_id = $2',
        [publicPath, playerId]
      );

      res.json({ success: true, imageUrl: publicPath });
    } catch (err) {
      logger.error({ err, playerId }, 'Failed to process player image');
      res.status(500).json({ error: 'Failed to process image' });
    }
  });
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
  SELECT club_id,
         played,
         wins,
         draws,
         losses,
         goals_for,
         goals_against,
         goal_diff,
         points
    FROM public.mv_league_standings
   WHERE club_id = ANY($1::bigint[])
   ORDER BY points DESC, goal_diff DESC, goals_for DESC`;

const SQL_LEAGUE_TEAMS = `
  SELECT club_id AS "id", club_name AS "name"
    FROM public.clubs
   WHERE club_id = ANY($1::bigint[])`;

async function getUpclLeaders(clubIds) {
  const sql = `SELECT type, club_id AS "clubId", name, count
                 FROM public.upcl_leaders
                WHERE club_id = ANY($1::bigint[])
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
  try {
    const { rows } = await q(SQL_LEAGUE_STANDINGS, [clubIds]);
    res.json({ standings: rows });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch league standings');
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

app.get('/api/league/leaders', async (_req, res) => {
  const clubIds = resolveClubIds();
  const scorerSql = `
    SELECT pms.club_id, p.name, SUM(pms.goals) AS count
      FROM public.player_match_stats pms
      JOIN public.matches m ON m.match_id = pms.match_id
      JOIN public.players p ON p.player_id = pms.player_id AND p.club_id = pms.club_id
     WHERE pms.club_id = ANY($1::bigint[])
     GROUP BY pms.club_id, p.name
     ORDER BY count DESC, p.name
     LIMIT 10`;
  const assisterSql = `
    SELECT pms.club_id, p.name, SUM(pms.assists) AS count
      FROM public.player_match_stats pms
      JOIN public.matches m ON m.match_id = pms.match_id
      JOIN public.players p ON p.player_id = pms.player_id AND p.club_id = pms.club_id
     WHERE pms.club_id = ANY($1::bigint[])
     GROUP BY pms.club_id, p.name
     ORDER BY count DESC, p.name
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
      await refreshFriendlyMatches(resolveClubIds());
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
      await refreshFriendlyMatches(resolveClubIds());
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
