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

test('aggregates matches from multiple clubs', async () => {
  const stub = mock.method(eaApi, 'fetchClubLeagueMatches', async () => ({
    '111': [
      { matchId: '1', timestamp: 1, clubs: { a: { name: 'A', score: '1' }, b: { name: 'B', score: '0' } }, players: {} },
      { matchId: '2', timestamp: 2, clubs: {}, players: {} }
    ],
    '222': [
      { matchId: '2', timestamp: 2, clubs: {}, players: {} },
      { matchId: '3', timestamp: 3, clubs: {}, players: {} }
    ]
  }));

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/matches`);
    const body = await res.json();
    assert.deepStrictEqual(body, [
      { matchId: '1', timestamp: 1, clubs: { a: { name: 'A', score: '1' }, b: { name: 'B', score: '0' } }, players: {} },
      { matchId: '2', timestamp: 2, clubs: {}, players: {} },
      { matchId: '3', timestamp: 3, clubs: {}, players: {} }
    ]);
  });

  stub.mock.restore();
});
