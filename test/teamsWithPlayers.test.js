const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const fetchStub = mock.method(global, 'fetch', async url => {
  if (url.includes('clubs/info')) {
    const ids = new URL(url).searchParams.get('clubIds').split(',');
    const obj = {};
    for (const id of ids) obj[id] = { name: 'Club', customLogo: 'L', season: { wins: 1 } };
    return { ok: true, json: async () => obj };
  }
  if (url.includes('clubs/members')) {
    return { ok: true, json: async () => ({ members: [{ name: 'A', position: 'ST', goals: 5 }] }) };
  }
  throw new Error('unexpected url ' + url);
});

delete require.cache[require.resolve('../server')];
const app = require('../server');
fetchStub.mock.restore();

async function withServer(fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('fetches and caches teams with players directly from EA', async () => {
  await withServer(async port => {
    const res1 = await fetch(`http://localhost:${port}/api/teams-with-players`);
    const body1 = await res1.json();
    assert.strictEqual(body1.ok, true);
    assert.ok(Array.isArray(body1.teams) && body1.teams.length > 0);
    for (const t of body1.teams) {
      assert.strictEqual(t.name, 'Club');
      assert.strictEqual(t.logo, 'L');
      assert.deepStrictEqual(t.players, [
        { name: 'A', position: 'ST', stats: { name: 'A', position: 'ST', goals: 5 } }
      ]);
    }
    const callsAfterFirst = fetchStub.mock.callCount();
    const res2 = await fetch(`http://localhost:${port}/api/teams-with-players`);
    await res2.json();
    assert.strictEqual(fetchStub.mock.callCount(), callsAfterFirst);
  });
});
