const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const eaApi = require('./services/eaApi');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

const BOTA_FC = {
  id: process.env.BOTA_CLUB_ID || '57985',
  name: process.env.BOTA_CLUB_NAME || 'Bota FC',
};
const ACTIVE_MATCH_TYPE = 'friendlyMatch';

app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

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

function getMatchId(match, index) {
  return String(match.matchId ?? match.matchid ?? match.id ?? `friendly-${index}`);
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
    id: getMatchId(match, index),
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
