const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const queryStub = mock.method(pool, 'query', async sql => {
  if (/SELECT \* FROM players/i.test(sql)) {
    return { rows: [ { player_id: '1', club_id: '10', name: 'Test', position: 'ST', last_seen: '2020-01-01' } ] };
  }
  return { rows: [] };
});

const app = require('../server');

async function withServer(fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('serves players from database', async () => {
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/players`);
    const body = await res.json();
      assert.deepStrictEqual(body, {
        players: [ { player_id: '1', club_id: '10', name: 'Test', position: 'ST', last_seen: '2020-01-01' } ]
      });
  });
  queryStub.mock.restore();
});
