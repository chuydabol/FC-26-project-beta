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

test('returns teams from database', async () => {
  const stub = mock.method(pool, 'query', async () => ({ rows: [{ id: 1 }] }));
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/teams`);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: true, teams: [{ id: 1 }] });
  });
  stub.mock.restore();
});

test('handles database errors gracefully', async () => {
  const stub = mock.method(pool, 'query', async () => {
    throw new Error('boom');
  });
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/teams`);
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: false, error: 'boom' });
  });
  stub.mock.restore();
});

