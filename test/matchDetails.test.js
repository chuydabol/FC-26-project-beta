const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');

async function withServer(fn) {
  const app = require('../server');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('returns aggregated match details', async () => {
  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/public\.match_participants/i.test(sql)) {
      return {
        rows: [
          { club_id: '1', is_home: true, goals: 2, club_name: 'Alpha' },
          { club_id: '2', is_home: false, goals: 1, club_name: 'Beta' },
        ],
      };
    }
    if (/public\.player_match_stats/i.test(sql)) {
      return {
        rows: [
          {
            club_id: '1',
            player_id: 'p1',
            goals: 2,
            assists: 1,
            passesmade: 30,
            passattempts: 40,
            position: 'ST',
            name: 'Home Striker',
          },
          {
            club_id: '1',
            player_id: 'p2',
            goals: 0,
            assists: 2,
            passesmade: 20,
            passattempts: 25,
            position: 'CM',
            name: 'Home Mid',
          },
          {
            club_id: '2',
            player_id: 'p3',
            goals: 1,
            assists: 0,
            passesmade: 15,
            passattempts: 20,
            position: 'LW',
            name: 'Away Wing',
          },
        ],
      };
    }
    if (/SELECT\s+raw\s+FROM\s+public\.matches/i.test(sql)) {
      return { rows: [{ raw: null }] };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/matches/123/details`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      matchId: '123',
      teams: [
        { clubId: '1', clubName: 'Alpha', isHome: true, goals: 2 },
        { clubId: '2', clubName: 'Beta', isHome: false, goals: 1 },
      ],
      goalscorers: {
        '1': [
          { playerId: 'p1', name: 'Home Striker', goals: 2, minutes: [] },
        ],
        '2': [
          { playerId: 'p3', name: 'Away Wing', goals: 1, minutes: [] },
        ],
      },
      passingAccuracy: { '1': 76.92, '2': 75 },
      possession: { '1': 76.47, '2': 23.53 },
      lineups: {
        '1': {
          formation: '2-2-1',
          layout: { defenders: 2, midfielders: 2, forwards: 1 },
          players: {
            defenders: [],
            midfielders: [
              { playerId: 'p2', name: 'Home Mid', position: 'CM' },
            ],
            forwards: [
              { playerId: 'p1', name: 'Home Striker', position: 'ST' },
            ],
          },
          totalPlayers: 2,
        },
        '2': {
          formation: '2-2-1',
          layout: { defenders: 2, midfielders: 2, forwards: 1 },
          players: {
            defenders: [],
            midfielders: [],
            forwards: [
              { playerId: 'p3', name: 'Away Wing', position: 'LW' },
            ],
          },
          totalPlayers: 1,
        },
      },
    });
  });

  stub.mock.restore();
});

