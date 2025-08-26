const { test, mock } = require('node:test');
const assert = require('assert');
const path = require('path');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.LEAGUE_CLUBS_PATH = path.join(__dirname, 'fixtures', 'leagueClubs.json');

const { pool } = require('../db');

async function withServer(fn) {
  const app = require('../server');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('serves league standings table', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/league_standings/i.test(sql)) {
      return {
        rows: [
          { clubId: '1', clubName: 'Alpha', points: 3, wins: 1, losses: 0, draws: 0, goalsFor: 2, goalsAgainst: 1 },
          { clubId: '2', clubName: 'Beta', points: 1, wins: 0, losses: 0, draws: 1, goalsFor: 1, goalsAgainst: 1 }
        ]
      };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/league`);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      standings: [
        { clubId: '1', clubName: 'Alpha', points: 3, wins: 1, losses: 0, draws: 0, goalsFor: 2, goalsAgainst: 1 },
        { clubId: '2', clubName: 'Beta', points: 1, wins: 0, losses: 0, draws: 1, goalsFor: 1, goalsAgainst: 1 }
      ]
    });
  });

  stub.mock.restore();
});
