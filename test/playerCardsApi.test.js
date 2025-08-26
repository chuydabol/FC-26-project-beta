const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const eaApi = require('../services/eaApi');
const { pool } = require('../db');
const app = require('../server');

const sampleVpro = '091|094|094|089|072|084|064|095|066|093|064|089|091|094|082|095|083|079|068|089|091|069|091|082|067|065|070';

async function withServer(fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('serves player cards with stats and name fallback', async () => {
  const fetchStub = mock.method(eaApi, 'fetchClubMembersWithRetry', async () => ({
    members: [
      {
        playerId: '1',
        name: 'Alice',
        gamesPlayed: '10',
        goals: '5',
        assists: '3',
        position: 'ST'
      },
      {
        name: 'Bob',
        gamesPlayed: '2',
        goals: '1',
        assists: '0',
        position: 'GK'
      }
    ]
  }));

  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/FROM public\.playercards/i.test(sql)) {
      return {
        rows: [
          {
            player_id: '1',
            club_id: '10',
            name: 'Alice',
            position: 'ST',
            vproattr: sampleVpro
          },
          {
            player_id: '99',
            club_id: '10',
            name: 'Bob',
            position: 'GK',
            vproattr: sampleVpro
          }
        ]
      };
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
    assert.strictEqual(alice.clubId, '10');
    assert(alice.stats && alice.stats.ovr > 0);
    assert.strictEqual(bob.playerId, null);
    assert(bob.stats && bob.stats.ovr > 0);
  });

  fetchStub.mock.restore();
  queryStub.mock.restore();
});
