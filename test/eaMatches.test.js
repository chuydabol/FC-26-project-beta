const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.LEAGUE_CLUB_IDS = '111,222';

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
  const stub = mock.method(eaApi, 'fetchClubLeagueMatches', async clubId => {
    if (clubId === '111') {
      return {
        '111': [
          {
            matchId: '1',
            timestamp: 1,
            clubs: { a: { name: 'A', score: '1' }, b: { name: 'B', score: '0' } },
            players: {
              a: {
                p1: { name: 'P1', pos: 'F', rating: '9.1', goals: '1', assists: '0' },
              },
            },
          },
          {
            matchId: '2',
            timestamp: 2,
            clubs: { c: { name: 'C', score: '0' }, d: { name: 'D', score: '2' } },
            players: {},
          },
        ],
      };
    }
    if (clubId === '222') {
      return {
        '222': [
          {
            matchId: '2',
            timestamp: 2,
            clubs: { c: { name: 'C', score: '0' }, d: { name: 'D', score: '2' } },
            players: {},
          },
          {
            matchId: '3',
            timestamp: 3,
            clubs: { e: { name: 'E', score: '1' }, f: { name: 'F', score: '1' } },
            players: {},
          },
        ],
      };
    }
    return {};
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/matches`);
    const body = await res.json();
    assert.deepStrictEqual(body, [
      {
        matchId: '1',
        timestamp: 1,
        homeTeam: { clubId: 'a', name: 'A', score: 1 },
        awayTeam: { clubId: 'b', name: 'B', score: 0 },
        players: [
          {
            clubId: 'a',
            playerId: 'p1',
            name: 'P1',
            pos: 'F',
            rating: 9.1,
            goals: 1,
            assists: 0,
          },
        ],
      },
      {
        matchId: '2',
        timestamp: 2,
        homeTeam: { clubId: 'c', name: 'C', score: 0 },
        awayTeam: { clubId: 'd', name: 'D', score: 2 },
        players: [],
      },
      {
        matchId: '3',
        timestamp: 3,
        homeTeam: { clubId: 'e', name: 'E', score: 1 },
        awayTeam: { clubId: 'f', name: 'F', score: 1 },
        players: [],
      },
    ]);
  });

  stub.mock.restore();
});

