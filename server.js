const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const eaApi = require('./services/eaApi');
const db = require('./db');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

const LEAGUE_CLUBS = [
  { id: '57985', name: 'Bota FC', conference: 'east', aliases: ['Bota FC'] },
  { id: '6297844', name: 'Inferign United', conference: 'east', aliases: ['Inferign United', 'Inferign Utd'] },
  { id: '1171188', name: 'True Egoistas', conference: 'east', aliases: ['True Egoistas', 'Egoistas'] },
  { id: '4671025', name: 'Versus One', conference: 'west', aliases: ['Versus One'] },
  { id: '654142', name: 'FC Wisconsin', conference: 'west', aliases: ['FC Wisconsin'] },
  { id: '129307', name: 'FC Sutton St', conference: 'west', aliases: ['FC Sutton St', 'FC Sutton'] },
];

const BOTA_FC = {
  id: process.env.BOTA_CLUB_ID || LEAGUE_CLUBS[0].id,
  name: process.env.BOTA_CLUB_NAME || LEAGUE_CLUBS[0].name,
};
const ACTIVE_MATCH_TYPE = 'friendlyMatch';

const NEWS_ITEMS = [
  {
    category: 'League Office',
    time: 'Preseason',
    headline: 'The UPCL table has been reset for the six confirmed clubs.',
  },
  {
    category: 'East',
    time: 'Preseason',
    headline: 'Eastern Conference entries: Bota FC, Inferign United, and True Egoistas.',
  },
  {
    category: 'West',
    time: 'Preseason',
    headline: 'Western Conference entries: Versus One, FC Wisconsin, and FC Sutton St.',
  },
  {
    category: 'Tables',
    time: 'Preseason',
    headline: 'No fake standings, form, or scorelines are listed before official results arrive.',
  },
];

app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

function requireAdmin(req, res, next) {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = req.headers?.['x-admin-password'];

  if (!expectedPassword || providedPassword !== expectedPassword) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}


function adminOnly(handler) {
  return (req, res) => requireAdmin(req, res, () => handler(req, res));
}


function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTimestamp(match) {
  const raw = match.timestamp ?? match.ts_ms ?? match.timeAgo ?? match.date;
  const number = Number(raw);
  if (!Number.isFinite(number)) return null;
  return number > 1_000_000_000_000 ? number : number * 1000;
}

function normalizeClub(clubId, club = {}) {
  const details = club.details || club;
  return {
    id: String(clubId),
    name: details.name || details.clubName || `Club ${clubId}`,
    goals: toNumber(club.goals ?? club.score ?? details.goals),
    isHome: details.isHome === true || details.isHome === 'true' || details.side === 'home',
  };
}

function getMatchId(match, index, team = BOTA_FC) {
  return String(match.matchId ?? match.matchid ?? match.id ?? `${team.id}-friendly-${index}`);
}

function normalizeMatch(match, index, team = BOTA_FC) {
  const clubs = Object.entries(match.clubs || {}).map(([clubId, club]) => normalizeClub(clubId, club));
  const bota = clubs.find(club => club.id === team.id) || null;
  const opponent = clubs.find(club => club.id !== team.id) || null;
  const botaGoals = bota ? bota.goals : null;
  const opponentGoals = opponent ? opponent.goals : null;
  let result = null;
  if (botaGoals !== null && opponentGoals !== null) {
    if (botaGoals > opponentGoals) result = 'W';
    else if (botaGoals < opponentGoals) result = 'L';
    else result = 'D';
  }

  return {
    id: getMatchId(match, index, team),
    timestamp: normalizeTimestamp(match),
    team: bota || { id: team.id, name: team.name, goals: botaGoals, isHome: false },
    opponent,
    clubs,
    score: {
      for: botaGoals,
      against: opponentGoals,
    },
    result,
    raw: match,
  };
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => toNumber(b.timestamp, 0) - toNumber(a.timestamp, 0));
}

const TEAM_ALIASES = {
  'bota fc': 'Bota FC',
  bota: 'Bota FC',
  'true egoistas': 'True Egoistas',
  egoistas: 'True Egoistas',
  'inferign united': 'Inferign United',
  'inferign utd': 'Inferign United',
  'versus one': 'Versus One',
  'fc wisconson': 'FC Wisconsin',
  'fc wisconsin': 'FC Wisconsin',
  'fc sutton st': 'FC Sutton St',
  'fc sutton': 'FC Sutton St',
};

const CLUB_BY_ID = new Map(LEAGUE_CLUBS.map(club => [club.id, club]));
const CLUB_BY_CANONICAL_NAME = new Map(LEAGUE_CLUBS.map(club => [club.name, club]));

function normalizeTeamName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\butd\b/g, 'united')
    .replace(/\bst\b/g, 'st')
    .replace(/\s+/g, ' ');
}

function getCanonicalTeamName(name) {
  return TEAM_ALIASES[normalizeTeamName(name)] || null;
}

function findLeagueClub(id, name) {
  const idMatch = id === null || id === undefined ? null : CLUB_BY_ID.get(String(id));
  if (idMatch) return idMatch;

  const canonicalName = getCanonicalTeamName(name);
  return canonicalName ? CLUB_BY_CANONICAL_NAME.get(canonicalName) || null : null;
}

function findLeagueClubByName(name) {
  const canonicalName = getCanonicalTeamName(name);
  return canonicalName ? CLUB_BY_CANONICAL_NAME.get(canonicalName) || null : null;
}

function createEmptyStanding(club, seed = 0) {
  return {
    seed,
    id: club.id,
    team: club.name,
    conference: club.conference,
    pl: 0,
    w: 0,
    d: 0,
    l: 0,
    gf: 0,
    ga: 0,
    gd: 0,
    pts: 0,
    form: [],
  };
}

function getMatchSortTime(match) {
  const rawDate = match.match_date || match.created_at;
  const dateTime = rawDate ? new Date(rawDate).getTime() : NaN;
  return Number.isFinite(dateTime) ? dateTime : toNumber(match.id, 0);
}

function addStandingResult(row, goalsFor, goalsAgainst, result) {
  row.pl += 1;
  row.gf += goalsFor;
  row.ga += goalsAgainst;

  if (result === 'W') {
    row.w += 1;
    row.pts += 3;
  } else if (result === 'L') {
    row.l += 1;
  } else {
    row.d += 1;
    row.pts += 1;
  }
}

function calculateStandings(savedMatches = []) {
  const rowsByClubId = new Map(LEAGUE_CLUBS.map(club => [club.id, createEmptyStanding(club)]));
  const formByClubId = new Map(LEAGUE_CLUBS.map(club => [club.id, []]));

  for (const match of savedMatches) {
    if (match.status !== 'approved' || match.competition !== 'league') continue;

    const homeClub = findLeagueClubByName(match.club_name);
    const awayClub = findLeagueClubByName(match.opponent_name);
    const clubScore = Number(match.club_score);
    const opponentScore = Number(match.opponent_score);

    if (!homeClub || !awayClub || homeClub.id === awayClub.id) continue;
    if (!Number.isFinite(clubScore) || !Number.isFinite(opponentScore)) continue;

    const homeResult = clubScore > opponentScore ? 'W' : clubScore < opponentScore ? 'L' : 'D';
    const awayResult = homeResult === 'W' ? 'L' : homeResult === 'L' ? 'W' : 'D';
    const sortTime = getMatchSortTime(match);

    addStandingResult(rowsByClubId.get(homeClub.id), clubScore, opponentScore, homeResult);
    addStandingResult(rowsByClubId.get(awayClub.id), opponentScore, clubScore, awayResult);
    formByClubId.get(homeClub.id).push({ result: homeResult, sortTime });
    formByClubId.get(awayClub.id).push({ result: awayResult, sortTime });
  }

  for (const row of rowsByClubId.values()) {
    row.gd = row.gf - row.ga;
    row.form = formByClubId
      .get(row.id)
      .sort((a, b) => b.sortTime - a.sortTime)
      .slice(0, 5)
      .map(item => item.result);
  }

  const sortRows = rows => rows
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team))
    .map((row, index) => ({ ...row, seed: index + 1 }));

  return {
    east: sortRows([...rowsByClubId.values()].filter(row => row.conference === 'east')),
    west: sortRows([...rowsByClubId.values()].filter(row => row.conference === 'west')),
  };
}

app.get('/', (_req, res) => {
  fs.readFile(path.join(PUBLIC_DIR, 'teams.html'), 'utf8', (error, html) => {
    if (error) {
      res.status(500).end('Unable to load page');
      return;
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, team: BOTA_FC, matchType: ACTIVE_MATCH_TYPE });
});

app.get('/api/team', (_req, res) => {
  res.json({ team: BOTA_FC, matchType: ACTIVE_MATCH_TYPE });
});

app.get('/api/news', (_req, res) => {
  res.json({ news: NEWS_ITEMS });
});

async function sendFriendlyMatches(_req, res) {
  try {
    const rawMatches = await eaApi.fetchFriendlyMatches(BOTA_FC.id);
    const matches = sortMatches(rawMatches.map((match, index) => normalizeMatch(match, index)));
    res.json({ team: BOTA_FC, matchType: ACTIVE_MATCH_TYPE, matches });
  } catch (error) {
    logger.error({ err: error, clubId: BOTA_FC.id }, 'Failed to fetch Bota FC friendly matches');
    res.status(502).json({
      error: 'Failed to fetch Bota FC friendly matches',
      details: error.message || 'EA API request failed',
      team: BOTA_FC,
      matchType: ACTIVE_MATCH_TYPE,
      matches: [],
    });
  }
}

app.get('/api/matches', sendFriendlyMatches);
app.get('/api/fixtures', sendFriendlyMatches);

app.post('/api/sync-matches', adminOnly(async (_req, res) => {
  const totals = {
    totalFetched: 0,
    inserted: 0,
    skipped: 0,
  };

  try {
    await db.ensureMatchesTable();

    for (const club of LEAGUE_CLUBS) {
      const rawMatches = await eaApi.fetchFriendlyMatches(club.id);
      totals.totalFetched += rawMatches.length;

      const matches = rawMatches.map((match, index) => normalizeMatch(match, index, club));
      for (const match of matches) {
        const inserted = await db.insertMatch(match, club);
        if (inserted) totals.inserted += 1;
        else totals.skipped += 1;
      }
    }

    res.json(totals);
  } catch (error) {
    logger.error({ err: error }, 'Failed to sync friendly matches to Postgres');
    res.status(500).json({
      error: 'Failed to sync friendly matches to Postgres',
      details: error.message || 'Database sync failed',
      ...totals,
    });
  }
}));

app.get('/api/db-matches', async (_req, res) => {
  try {
    const matches = await db.getSavedMatches();
    res.json({ matches });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load saved matches from Postgres');
    res.status(500).json({
      error: 'Failed to load saved matches from Postgres',
      details: error.message || 'Database query failed',
      matches: [],
    });
  }
});


app.get('/api/pending-matches', adminOnly(async (_req, res) => {
  try {
    const matches = await db.getPendingMatches();
    res.json({ matches });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load pending matches from Postgres');
    res.status(500).json({
      error: 'Failed to load pending matches from Postgres',
      details: error.message || 'Database query failed',
      matches: [],
    });
  }
}));

app.post('/api/matches/:matchId/approve', adminOnly(async (req, res) => {
  try {
    const match = await db.approveMatch(req.params.matchId, {
      competition: req.body?.competition || 'league',
      matchday: req.body?.matchday,
      notes: req.body?.notes,
    });

    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    res.json({ match });
  } catch (error) {
    const status = /competition|matchday/.test(error.message || '') ? 400 : 500;
    logger.error({ err: error, matchId: req.params.matchId }, 'Failed to approve match');
    res.status(status).json({
      error: 'Failed to approve match',
      details: error.message || 'Database update failed',
    });
  }
}));

app.post('/api/matches/:matchId/reject', adminOnly(async (req, res) => {
  try {
    const match = await db.rejectMatch(req.params.matchId, { notes: req.body?.notes });

    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    res.json({ match });
  } catch (error) {
    logger.error({ err: error, matchId: req.params.matchId }, 'Failed to reject match');
    res.status(500).json({
      error: 'Failed to reject match',
      details: error.message || 'Database update failed',
    });
  }
}));

app.post('/api/matches/:matchId/friendly', adminOnly(async (req, res) => {
  try {
    const match = await db.approveMatch(req.params.matchId, {
      competition: 'friendly',
      matchday: req.body?.matchday,
      notes: req.body?.notes,
    });

    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    res.json({ match });
  } catch (error) {
    const status = /competition|matchday/.test(error.message || '') ? 400 : 500;
    logger.error({ err: error, matchId: req.params.matchId }, 'Failed to mark match as friendly');
    res.status(status).json({
      error: 'Failed to mark match as friendly',
      details: error.message || 'Database update failed',
    });
  }
}));



app.get('/api/player-stats', async (_req, res) => {
  try {
    const players = await db.getPlayerStats();
    res.json({ players });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load approved league player stats');
    res.status(500).json({
      error: 'Failed to load player stats',
      details: error.message || 'Database query failed',
      players: [],
    });
  }
});

app.get('/api/standings', async (_req, res) => {
  try {
    const matches = await db.getApprovedLeagueMatches();
    res.json(calculateStandings(matches));
  } catch (error) {
    logger.error({ err: error }, 'Failed to build standings from Postgres matches');
    res.status(500).json({
      error: 'Failed to build standings from Postgres matches',
      details: error.message || 'Database query failed',
      east: [],
      west: [],
    });
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Bota FC match viewer running on :${port}`);
  });
}

module.exports = app;
module.exports.normalizeMatch = normalizeMatch;
module.exports.normalizeTimestamp = normalizeTimestamp;
module.exports.BOTA_FC = BOTA_FC;
module.exports.LEAGUE_CLUBS = LEAGUE_CLUBS;
module.exports.NEWS_ITEMS = NEWS_ITEMS;
module.exports.TEAM_ALIASES = TEAM_ALIASES;
module.exports.calculateStandings = calculateStandings;
module.exports.findLeagueClub = findLeagueClub;
module.exports.findLeagueClubByName = findLeagueClubByName;
module.exports.getCanonicalTeamName = getCanonicalTeamName;
module.exports.requireAdmin = requireAdmin;
module.exports.adminOnly = adminOnly;
