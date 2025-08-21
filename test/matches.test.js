const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const pool = require('../db');
const queryStub = mock.method(pool, 'query', async sql => {
  if (/FROM matches/i.test(sql)) {
    return {
      rows: [
        {
          match_id: '1',
          ts_ms: 1000,
          clubs_obj: {
            '1': { details: { name: 'A' }, goals: 1 },
            '2': { details: { name: 'B' }, goals: 2 }
          }
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
    assert.deepStrictEqual(body, {
      matches: [
        {
          id: '1',
          timestamp: 1000,
          clubs: {
            '1': { details: { name: 'A' }, goals: 1 },
            '2': { details: { name: 'B' }, goals: 2 }
          }
        }
      ]
    });
  });
  queryStub.mock.restore();
});
