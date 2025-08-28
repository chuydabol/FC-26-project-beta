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

test('serves league leaders', async () => {
  const scorerRows = [{ club_id: '1', name: 'Alice', count: 3 }];
  const assisterRows = [{ club_id: '1', name: 'Bob', count: 5 }];
  const LEAGUE_START_MS = Date.parse('2025-08-27T23:59:00-07:00');
  const LEAGUE_END_MS = Date.parse('2025-09-03T23:59:00-07:00');

  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/SUM\(pms\.goals\)/i.test(sql)) {
      assert.deepStrictEqual(params, [['1'], LEAGUE_START_MS, LEAGUE_END_MS]);
      return { rows: scorerRows };
    }
    if (/SUM\(pms\.assists\)/i.test(sql)) {
      assert.deepStrictEqual(params, [['1'], LEAGUE_START_MS, LEAGUE_END_MS]);
      return { rows: assisterRows };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/league/leaders`);
    const body = await res.json();
    assert.deepStrictEqual(body, { scorers: scorerRows, assisters: assisterRows });
  });

  stub.mock.restore();
});
