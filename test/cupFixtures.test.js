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

test('serves cup fixtures', async () => {
  const row = {
    id: 1,
    cup: 'TEST',
    home: 'A',
    away: 'B',
    round: 'Final',
    when_ts: 123,
    status: 'scheduled',
    hs: 1,
    as: 2,
    created_at: 456,
  };
  const stub = mock.method(pool, 'query', async () => ({ rows: [row] }));

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/cup/fixtures?cup=TEST`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      fixtures: [
        {
          id: 1,
          cup: 'TEST',
          home: 'A',
          away: 'B',
          round: 'Final',
          when: 123,
          status: 'scheduled',
          score: { hs: 1, as: 2 },
          createdAt: 456,
        },
      ],
    });
  });

  stub.mock.restore();
});

