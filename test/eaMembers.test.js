const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const eaApi = require('../services/eaApi');
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

test('normalizes array response', async () => {
  const stub = mock.method(eaApi, 'fetchClubMembersWithRetry', async () => [{ name: 'A' }]);
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/clubs/123/members`);
    const body = await res.json();
    assert.deepStrictEqual(body, { members: [{ name: 'A' }] });
  });
  stub.mock.restore();
});

test('normalizes object map response', async () => {
  const stub = mock.method(
    eaApi,
    'fetchClubMembersWithRetry',
    async () => ({ members: { a: { name: 'A' }, b: { name: 'B' } } })
  );
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/clubs/123/members`);
    const body = await res.json();
    assert.deepStrictEqual(body, { members: [{ name: 'A' }, { name: 'B' }] });
  });
  stub.mock.restore();
});
