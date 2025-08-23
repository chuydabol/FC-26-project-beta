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

test('proxies EA members stats', async () => {
  const fetchStub = mock.method(eaApi, 'fetchClubMembersWithRetry', async clubId => ({
    members: [
      { playerId: '1', name: 'Alice', proPos: 'ST', proOverall: 82 },
      { playerId: '2', name: 'Bob', proPos: 'GK', proOverall: 70 }
    ]
  }));

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/teams/10/players`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.members.length, 2);
    assert(fetchStub.mock.calls.some(c => c.arguments[0] === '10'));
  });

  fetchStub.mock.restore();
});

test('returns empty array if EA call fails', async () => {
  const fetchStub = mock.method(eaApi, 'fetchClubMembersWithRetry', async () => {
    throw new Error('EA down');
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/teams/10/players`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { members: [] });
  });

  fetchStub.mock.restore();
});
