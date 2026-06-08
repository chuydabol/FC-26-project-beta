const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const eaApi = require('../services/eaApi');
const app = require('../server');

function adminHeaders(extraHeaders = {}) {
  return { ...extraHeaders, 'x-admin-password': ADMIN_PASSWORD };
}

async function withServer(fn) {
  const server = app.listen(0);
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

test('normalizes Bota FC friendly matches', () => {
  const match = app.normalizeMatch({
    matchId: 'abc123',
    timestamp: 1_700_000_000,
    clubs: {
      57985: { goals: '3', details: { name: 'Bota FC', isHome: 'true' } },
      123: { goals: '1', details: { name: 'Rivals FC', isHome: 'false' } },
    },
  }, 0);

  assert.equal(match.id, 'abc123');
  assert.equal(match.timestamp, 1_700_000_000_000);
  assert.equal(match.team.name, 'Bota FC');
  assert.equal(match.opponent.name, 'Rivals FC');
  assert.deepEqual(match.score, { for: 3, against: 1 });
  assert.equal(match.result, 'W');
});

test('GET /api/matches returns friendly matches for Bota FC', async () => {
  const fetchStub = mock.method(eaApi, 'fetchFriendlyMatches', async clubId => {
    assert.equal(clubId, '57985');
    return [
      {
        matchId: 'older',
        timestamp: 1_700_000_000,
        clubs: {
          57985: { goals: 0, details: { name: 'Bota FC' } },
          111: { goals: 0, details: { name: 'Draw FC' } },
        },
      },
      {
        matchId: 'newer',
        timestamp: 1_700_000_100,
        clubs: {
          57985: { goals: 2, details: { name: 'Bota FC' } },
          222: { goals: 4, details: { name: 'Winners FC' } },
        },
      },
    ];
  });

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/matches`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.team.name, 'Bota FC');
    assert.equal(body.matchType, 'friendlyMatch');
    assert.equal(body.matches.length, 2);
    assert.equal(body.matches[0].id, 'newer');
    assert.equal(body.matches[0].result, 'L');
    assert.equal(body.matches[1].result, 'D');
  });

  fetchStub.mock.restore();
});

test('POST /api/sync-matches stores recent matches for all league clubs', async () => {
  const db = require('../db');
  const fetchedClubIds = [];
  const insertedMatches = [];
  const fetchStub = mock.method(eaApi, 'fetchFriendlyMatches', async clubId => {
    fetchedClubIds.push(clubId);
    return [
      {
        matchId: `match-${clubId}`,
        timestamp: 1_700_000_000,
        clubs: {
          [clubId]: { goals: 2, details: { name: `Club ${clubId}` } },
          999: { goals: 1, details: { name: 'Opponent FC' } },
        },
      },
    ];
  });
  const ensureStub = mock.method(db, 'ensureMatchesTable', async () => {});
  const insertStub = mock.method(db, 'insertMatch', async (match, club) => {
    insertedMatches.push({ match, club });
    return insertedMatches.length % 2 === 1;
  });

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/sync-matches`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { totalFetched: 6, inserted: 3, skipped: 3 });
  });

  assert.deepEqual(fetchedClubIds, app.LEAGUE_CLUBS.map(club => club.id));
  assert.equal(ensureStub.mock.callCount(), 1);
  assert.equal(insertStub.mock.callCount(), 6);
  assert.equal(insertedMatches[0].club.name, 'Bota FC');
  assert.equal(insertedMatches[0].match.id, 'match-57985');

  fetchStub.mock.restore();
  ensureStub.mock.restore();
  insertStub.mock.restore();
});

test('POST /api/sync-matches rejects missing admin password', async () => {
  const db = require('../db');
  const ensureStub = mock.method(db, 'ensureMatchesTable', async () => {
    throw new Error('admin auth should run before sync');
  });

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/sync-matches`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: 'Unauthorized' });
  });

  assert.equal(ensureStub.mock.callCount(), 0);
  ensureStub.mock.restore();
});

test('GET /api/news returns public news without admin password', async () => {
  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/news`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.news.map(item => item.category), app.NEWS_ITEMS.map(item => item.category));
  });
});

test('GET /api/db-matches returns saved Postgres matches', async () => {
  const db = require('../db');
  const getStub = mock.method(db, 'getSavedMatches', async () => [
    { match_id: 'newer', match_date: '2026-01-02T00:00:00.000Z' },
    { match_id: 'older', match_date: '2026-01-01T00:00:00.000Z' },
  ]);

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/db-matches`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.matches.map(match => match.match_id), ['newer', 'older']);
  });

  assert.equal(getStub.mock.callCount(), 1);
  getStub.mock.restore();
});

test('calculateStandings builds conference tables from saved league matches only', () => {
  const standings = app.calculateStandings([
    {
      id: 1,
      source_club_id: '57985',
      club_name: 'Bota FC',
      opponent_name: 'Inferign Utd',
      club_score: 3,
      opponent_score: 1,
      match_date: '2026-01-01T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
    {
      id: 2,
      source_club_id: '1171188',
      club_name: 'Egoistas',
      opponent_name: 'Bota FC',
      club_score: 2,
      opponent_score: 2,
      match_date: '2026-01-02T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
    {
      id: 3,
      source_club_id: '4671025',
      club_name: 'Versus One',
      opponent_name: 'FC Wisconson',
      club_score: 0,
      opponent_score: 1,
      match_date: '2026-01-03T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
    {
      id: 4,
      source_club_id: '57985',
      club_name: 'Bota FC',
      opponent_name: 'Non League FC',
      club_score: 9,
      opponent_score: 0,
      match_date: '2026-01-04T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
    {
      id: 5,
      source_club_id: '57985',
      club_name: 'Bota FC',
      opponent_name: 'Inferign United',
      club_score: 9,
      opponent_score: 0,
      match_date: '2026-01-05T00:00:00.000Z',
      status: 'pending',
      competition: 'league',
    },
    {
      id: 6,
      source_club_id: '57985',
      club_name: 'Bota FC',
      opponent_name: 'Inferign United',
      club_score: 9,
      opponent_score: 0,
      match_date: '2026-01-06T00:00:00.000Z',
      status: 'approved',
      competition: 'friendly',
    },
  ]);

  assert.deepEqual(standings.east.map(row => row.team), ['Bota FC', 'True Egoistas', 'Inferign United']);
  assert.deepEqual(standings.west.map(row => row.team), ['FC Wisconsin', 'FC Sutton St', 'Versus One']);

  const bota = standings.east[0];
  assert.equal(bota.pl, 2);
  assert.equal(bota.w, 1);
  assert.equal(bota.d, 1);
  assert.equal(bota.l, 0);
  assert.equal(bota.gf, 5);
  assert.equal(bota.ga, 3);
  assert.equal(bota.gd, 2);
  assert.equal(bota.pts, 4);
  assert.deepEqual(bota.form, ['D', 'W']);

  const sutton = standings.west.find(row => row.team === 'FC Sutton St');
  assert.equal(sutton.pl, 0);
  assert.equal(sutton.pts, 0);
});


test('calculateStandings canonicalizes team aliases before counting league matches', () => {
  const standings = app.calculateStandings([
    {
      id: 1,
      source_club_id: '654142',
      club_name: 'FC Wisconson',
      opponent_name: 'fc sutton',
      club_score: 2,
      opponent_score: 0,
      match_date: '2026-01-01T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
    {
      id: 2,
      source_club_id: '57985',
      club_name: 'Non League FC',
      opponent_name: 'Bota FC',
      club_score: 9,
      opponent_score: 0,
      match_date: '2026-01-02T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
  ]);

  assert.deepEqual(standings.west.map(row => row.team), ['FC Wisconsin', 'Versus One', 'FC Sutton St']);

  const wisconsin = standings.west.find(row => row.team === 'FC Wisconsin');
  assert.equal(wisconsin.pl, 1);
  assert.equal(wisconsin.w, 1);
  assert.equal(wisconsin.gf, 2);
  assert.equal(wisconsin.pts, 3);

  const sutton = standings.west.find(row => row.team === 'FC Sutton St');
  assert.equal(sutton.pl, 1);
  assert.equal(sutton.l, 1);
  assert.equal(sutton.ga, 2);

  const bota = standings.east.find(row => row.team === 'Bota FC');
  assert.equal(bota.pl, 0);
});

test('GET /api/player-stats returns approved league player totals', async () => {
  const db = require('../db');
  const getStub = mock.method(db, 'getPlayerStats', async () => [
    {
      player_name: 'Clinical Finisher',
      club_name: 'Bota FC',
      matches_played: 2,
      goals: 5,
      assists: 1,
      passes_attempted: 20,
      passes_made: 18,
      pass_percentage: 90,
      tackles_attempted: 4,
      tackles_made: 3,
      tackle_percentage: 75,
      motm_count: 1,
    },
  ]);

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/player-stats`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.players.length, 1);
    assert.equal(body.players[0].player_name, 'Clinical Finisher');
    assert.equal(body.players[0].goals, 5);
    assert.equal(body.players[0].pass_percentage, 90);
  });

  assert.equal(getStub.mock.callCount(), 1);
  getStub.mock.restore();
});

test('GET /api/standings returns calculated standings from saved Postgres matches', async () => {
  const db = require('../db');
  const getStub = mock.method(db, 'getApprovedLeagueMatches', async () => [
    {
      id: 1,
      source_club_id: '57985',
      club_name: 'Bota FC',
      opponent_name: 'Inferign United',
      club_score: 1,
      opponent_score: 0,
      match_date: '2026-01-01T00:00:00.000Z',
      status: 'approved',
      competition: 'league',
    },
  ]);

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/standings`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.east.length, 3);
    assert.equal(body.west.length, 3);
    assert.equal(body.east[0].team, 'Bota FC');
    assert.equal(body.east[0].pts, 3);
    assert.equal(body.east[0].form[0], 'W');
  });

  assert.equal(getStub.mock.callCount(), 1);
  getStub.mock.restore();
});

test('GET /api/pending-matches returns synced matches awaiting approval', async () => {
  const db = require('../db');
  const getStub = mock.method(db, 'getPendingMatches', async () => [
    { match_id: 'pending-1', status: 'pending', competition: 'friendly' },
  ]);

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/pending-matches`, { headers: adminHeaders() });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.matches.map(match => match.match_id), ['pending-1']);
  });

  assert.equal(getStub.mock.callCount(), 1);
  getStub.mock.restore();
});

test('POST /api/matches/:matchId/approve approves a league match with optional matchday', async () => {
  const db = require('../db');
  const approveStub = mock.method(db, 'approveMatch', async (matchId, options) => {
    assert.equal(matchId, 'match-123');
    assert.deepEqual(options, { competition: 'league', matchday: 2, notes: undefined });
    return { match_id: matchId, status: 'approved', competition: 'league', matchday: 2 };
  });

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/matches/match-123/approve`, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ competition: 'league', matchday: 2 }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.match.status, 'approved');
    assert.equal(body.match.competition, 'league');
  });

  assert.equal(approveStub.mock.callCount(), 1);
  approveStub.mock.restore();
});

test('POST /api/matches/:matchId/friendly marks a match as friendly', async () => {
  const db = require('../db');
  const approveStub = mock.method(db, 'approveMatch', async (matchId, options) => {
    assert.equal(matchId, 'match-789');
    assert.deepEqual(options, { competition: 'friendly', matchday: undefined, notes: undefined });
    return { match_id: matchId, status: 'approved', competition: 'friendly' };
  });

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/matches/match-789/friendly`, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.match.status, 'approved');
    assert.equal(body.match.competition, 'friendly');
  });

  assert.equal(approveStub.mock.callCount(), 1);
  approveStub.mock.restore();
});

test('POST /api/matches/:matchId/reject marks a match rejected', async () => {
  const db = require('../db');
  const rejectStub = mock.method(db, 'rejectMatch', async matchId => {
    assert.equal(matchId, 'match-456');
    return { match_id: matchId, status: 'rejected', competition: 'friendly' };
  });

  await withServer(async port => {
    const response = await fetch(`http://localhost:${port}/api/matches/match-456/reject`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.match.status, 'rejected');
  });

  assert.equal(rejectStub.mock.callCount(), 1);
  rejectStub.mock.restore();
});
