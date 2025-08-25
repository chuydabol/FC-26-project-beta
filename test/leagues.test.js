const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

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

test('serves league standings', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/match_participants/i.test(sql)) {
      return { rows: [ { clubId: '1', P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3 } ] };
    }
    if (/from\s+public\.clubs/i.test(sql)) {
      return { rows: [ { id: '1', name: 'Team 1' } ] };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/leagues/test`);
    const body = await res.json();
    assert.deepStrictEqual(body.teams, [ { id: '1', name: 'Team 1' } ]);
    assert.deepStrictEqual(body.standings, [ { clubId: '1', P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3 } ]);
  });

  stub.mock.restore();
});

test('standings include teams with zero matches', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/match_participants/i.test(sql)) {
      return { rows: [ { clubId: '1', P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 } ] };
    }
    if (/from\s+public\.clubs/i.test(sql)) {
      return { rows: [ { id: '1', name: 'Team 1' } ] };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/leagues/test`);
    const body = await res.json();
    assert.deepStrictEqual(body.standings, [ { clubId: '1', P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 } ]);
    assert.deepStrictEqual(body.teams, [ { id: '1', name: 'Team 1' } ]);
  });

  stub.mock.restore();
});

test('serves league leaders', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/goals::int/i.test(sql)) {
      return { rows: [ { clubId: '1', name: 'A', count: 5 } ] };
    }
    if (/assists::int/i.test(sql)) {
      return { rows: [ { clubId: '2', name: 'B', count: 3 } ] };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/leagues/test/leaders`);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      scorers: [ { clubId: '1', name: 'A', count: 5 } ],
      assisters: [ { clubId: '2', name: 'B', count: 3 } ]
    });
  });

  stub.mock.restore();
});

test('serves league matches including non-league opponents', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/FROM\s+public\.matches/i.test(sql)) {
      assert.match(
        sql,
        /home\.club_id\s*=\s*ANY\(\$1\)\s+OR\s+away\.club_id\s*=\s*ANY\(\$1\)/i
      );
      return {
        rows: [
          {
            id: '1',
            when: 1,
            home: '2491998',
            away: '999',
            hs: 1,
            as: 0
          }
        ]
      };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/leagues/test/matches`);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      matches: [
        {
          id: '1',
          home: '2491998',
          away: '999',
          round: null,
          when: 1,
          status: 'final',
          score: { hs: 1, as: 0 }
        }
      ]
    });
  });

  stub.mock.restore();
});
