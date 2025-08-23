const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const eaApi = require('../services/eaApi');
const attrs = require('../services/playerAttributes');
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

test('serves team players with attribute lookup', async () => {
  const fetchStub = mock.method(eaApi, 'fetchPlayersForClubWithRetry', async () => ({
    members: [
      { playerId: '1', name: 'Alice', proPos: 'ST' },
      { playerId: '2', name: 'Bob', proPos: 'GK' }
    ]
  }));
  const attrStub = mock.method(attrs, 'getPlayerAttributes', async id => {
    if (id === '1') return { pac:90, sho:80, pas:70, dri:85, def:40, phy:75, ovr:82 };
    return null;
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/teams/10/players`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.players.length, 2);
    const alice = body.players.find(p => p.playerId === '1');
    const bob = body.players.find(p => p.playerId === '2');
    assert(alice.stats && alice.stats.ovr === 82);
    assert.strictEqual(bob.stats, null);
  });

  fetchStub.mock.restore();
  attrStub.mock.restore();
});
