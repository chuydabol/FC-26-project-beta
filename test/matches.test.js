const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const pool = require('../db');
const queryStub = mock.method(pool, 'query', async (sql, params) => {
  if (/FROM matches/i.test(sql)) {
    return {
      rows: [
        {
          id: '1',
          matchdate: '2024-01-01T00:00:00Z',
          clubids: ['123'],
          raw: { clubIds: ['123'] }
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

test('serves league matches from db', async () => {
  await withServer(async port => {
    const res = await fetch(
      `http://localhost:${port}/api/leagues/123/matches`
    );
    const body = await res.json();
    assert.deepStrictEqual(body, [
      {
        id: '1',
        matchdate: '2024-01-01T00:00:00Z',
        clubids: ['123'],
        raw: { clubIds: ['123'] }
      }
    ]);
  });
  queryStub.mock.restore();
});
