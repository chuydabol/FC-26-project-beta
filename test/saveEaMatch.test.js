const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const { saveEaMatch } = require('../server');

test('saveEaMatch stores home/away flags for clubs', async () => {
  const calls = [];
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      calls.push(params);
    }
    return { rows: [], rowCount: 1 };
  });

  const match = {
    matchId: 'm1',
    timestamp: 1000,
    clubs: {
      '10': { details: { name: 'Alpha', isHome: 1 }, goals: 3 },
      '20': { details: { name: 'Beta', isHome: 0 }, goals: 1 },
    },
  };

  await saveEaMatch(match);

  queryStub.mock.restore();
  assert.deepStrictEqual(calls, [
    ['m1', '10', true, 3],
    ['m1', '20', false, 1],
  ]);
});

test('saveEaMatch updates player stats only once for duplicate matches', async () => {
  const playerCalls = [];
  let insertMatchCalls = 0;

  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.matches/i.test(sql)) {
      insertMatchCalls++;
      return { rowCount: insertMatchCalls === 1 ? 1 : 0 };
    }
    if (/INSERT INTO public\.players/i.test(sql)) {
      playerCalls.push(params);
    }
    return { rowCount: 1 };
  });

  const match = {
    matchId: 'm2',
    timestamp: 1000,
    clubs: {
      '10': { details: { name: 'Alpha', isHome: 1 }, goals: 1 },
    },
    players: {
      '10': {
        'p1': { name: 'Player 1', position: 'ST', goals: 2, assists: 1 },
      },
    },
  };

  await saveEaMatch(match);
  await saveEaMatch(match);

  queryStub.mock.restore();
  assert.strictEqual(playerCalls.length, 1);
});
