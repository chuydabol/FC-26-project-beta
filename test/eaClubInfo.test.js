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

test('fetches club info from EA', async () => {
  const stub = mock.method(eaApi, 'fetchClubInfoWithRetry', async () => ({ name: 'Club', customLogo: 'L' }));
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/clubs/123/info`);
    const body = await res.json();
    assert.deepStrictEqual(body, { club: { name: 'Club', customLogo: 'L' } });
  });
  stub.mock.restore();
});

test('fetches club info via backend proxy', async () => {
  const stub = mock.method(eaApi, 'fetchClubInfoWithRetry', async () => ({ name: 'Club', customLogo: 'L' }));
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/club-info/123`);
    const body = await res.json();
    assert.deepStrictEqual(body, { club: { name: 'Club', customLogo: 'L' } });
  });
  stub.mock.restore();
});
