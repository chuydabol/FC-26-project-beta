const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const eaApi = require('../services/eaApi');
const app = require('../server');

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
