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
    if (/mv_league_standings/i.test(sql)) {
      assert.deepStrictEqual(params, [['1']]);
      return {
        rows: [
          {
            club_id: '1',
            played: 1,
            wins: 0,
            draws: 0,
            losses: 1,
            goals_for: 2,
            goals_against: 3,
            goal_diff: -1,
            points: 0,
          },
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
        {
          club_id: '1',
          played: 1,
          wins: 0,
          draws: 0,
          losses: 1,
          goals_for: 2,
          goals_against: 3,
          goal_diff: -1,
          points: 0,
        },
      ],
    });
  });

  stub.mock.restore();
});
