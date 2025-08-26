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
    if (/jsonb_object_keys/i.test(sql)) {
      assert.match(sql, /WHERE cid = ANY\(\$1\)/i);
      assert.deepStrictEqual(params, [['1']]);
      const rows = [
        { club_id: '1', wins: 1, losses: 0, draws: 0, goals_for: 2, goals_against: 1, points: 3 },
        { club_id: '2', wins: 0, losses: 0, draws: 1, goals_for: 1, goals_against: 1, points: 1 }
      ].filter(r => params[0].includes(r.club_id));
      return { rows };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/league`);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      standings: [
        { club_id: '1', wins: 1, losses: 0, draws: 0, goals_for: 2, goals_against: 1, points: 3 }
      ]
    });
  });

  stub.mock.restore();
});
