const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const eaApi = require('../services/eaApi');

const client = {
  query: mock.fn(async () => ({ rows: [] })),
  release: mock.fn()
};
mock.method(pool, 'connect', async () => client);

mock.method(eaApi, 'fetchPlayersForClubWithRetry', async clubId => {
  if (clubId === '1527486') throw new Error('fail');
  return [{ playerId: '1', name: 'Test', proPos: 'ST', vProAttr: 'abc' }];
});

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

test('skips failing clubs and returns byClub', async () => {
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/players`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.byClub);
    assert.deepStrictEqual(body.byClub['1527486'], []);
    const sample = body.byClub['2491998'][0];
    assert.deepStrictEqual(sample, { player_id: '1', name: 'Test', position: 'ST', vproattr: 'abc' });
  });
  pool.connect.mock.restore();
  eaApi.fetchPlayersForClubWithRetry.mock.restore();
});
