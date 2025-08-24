const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const eaApi = require('../services/eaApi');
const { pool } = require('../db');
const app = require('../server');

const sampleVpro = '091|094|094|089|072|084|064|095|066|093|064|089|091|094|082|095|083|079|068|089|091|069|091|082|067|065';

async function withServer(fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('serves player cards for specific club', async () => {
  const fetchStub = mock.method(eaApi, 'fetchClubMembersWithRetry', async () => ({
    members: [
      { name: 'Alice', gamesPlayed: '10', goals: '5', assists: '3', position: 'ST' },
      { name: 'Bob', gamesPlayed: '2', goals: '1', assists: '0', position: 'GK' }
    ]
  }));

  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/FROM public\.playercards/i.test(sql)) {
      return { rows: [{ player_id: '1', name: 'Alice', position: 'ST', vproattr: sampleVpro, ovr: 83 }] };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/clubs/10/player-cards`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.members.length, 2);
    const alice = body.members.find(p => p.name === 'Alice');
    const bob = body.members.find(p => p.name === 'Bob');
    assert(alice.stats && alice.stats.ovr > 0);
    assert.strictEqual(alice.tier, 'obsidian');
    assert.strictEqual(bob.stats, null);
    assert.strictEqual(bob.tier, 'iron');
  });

  const upsertCall = queryStub.mock.calls.find(c => /INSERT INTO public\.players/i.test(c.arguments[0]));
  assert(upsertCall, 'players table should be upserted');

  fetchStub.mock.restore();
  queryStub.mock.restore();
});
