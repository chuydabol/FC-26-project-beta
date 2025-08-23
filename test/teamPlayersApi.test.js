const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

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
  const realFetch = global.fetch;
  const fetchStub = mock.method(global, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://proclubs.ea.com')) {
      return {
        ok: true,
        json: async () => ({
          members: [
            { playerId: '1', name: 'Alice', proPos: 'ST', proOverall: 82 },
            { playerId: '2', name: 'Bob', proPos: 'GK', proOverall: 70 }
          ]
        })
      };
    }
    return realFetch(url, opts);
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/teams/10/players`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.members.length, 2);
    assert(fetchStub.mock.calls.some(c => String(c.arguments[0]).includes('clubId=10')));
  });

  fetchStub.mock.restore();
});
