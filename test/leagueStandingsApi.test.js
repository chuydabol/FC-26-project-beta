const { test, mock } = require('node:test');
const assert = require('assert');
const path = require('path');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.LEAGUE_CLUBS_PATH = path.join(__dirname, 'fixtures', 'leagueClubs.json');
process.env.DEFAULT_LEAGUE_ID = 'test';

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
  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/match_participants/i.test(sql)) {
      const start = Date.parse('2025-08-27T23:59:00-07:00');
      const end = Date.parse('2025-09-03T23:59:00-07:00');
      assert.deepStrictEqual(params, [['1'], start, end]);
      return {
        rows: [
          { clubId: '1', P: 1, W: 0, D: 0, L: 1, GF: 2, GA: 3, GD: -1, Pts: 0 },
        ],
      };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/league`);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      standings: [
        { clubId: '1', P: 1, W: 0, D: 0, L: 1, GF: 2, GA: 3, GD: -1, Pts: 0 },
      ],
    });
  });

  stub.mock.restore();
});
