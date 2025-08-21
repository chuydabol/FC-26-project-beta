const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const pool = require('../db');
const queryStub = mock.method(pool, 'query', async sql => {
  if (/FROM matches/i.test(sql)) {
    return {
      rows: [
        {
          id: '1',
          club_id: '123',
          timestamp: 123,
          data: { matchId: '1', foo: 'bar' }
        }
      ]
    };
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

test('serves recent matches from db', async () => {
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/matches`);
    const body = await res.json();
    assert.deepStrictEqual(body, [{ matchId: '1', foo: 'bar' }]);
  });
  queryStub.mock.restore();
});
