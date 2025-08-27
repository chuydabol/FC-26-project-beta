const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const { saveEaMatch } = require('../server');
const { rebuildPlayerStats } = require('../scripts/rebuildPlayerStats');

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

test('duplicate saveEaMatch calls do not double-count player stats', async () => {
  const players = new Map();
  const pms = new Map();

  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.matches/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.players \(player_id, club_id, name, position, vproattr, goals, assists, last_seen\)/i.test(sql)) {
      const [pid, cid] = params;
      const key = `${pid}_${cid}`;
      if (!players.has(key)) players.set(key, { goals: 0, assists: 0 });
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.player_match_stats/i.test(sql)) {
      const [mid, pid, cid, g, a] = params;
      const key = `${mid}_${pid}_${cid}`;
      if (pms.has(key)) return { rowCount: 0 };
      pms.set(key, { goals: g, assists: a });
      return { rowCount: 1 };
    }
    if (/UPDATE public\.players p SET/i.test(sql)) {
      const [pid, cid] = params;
      let goals = 0, assists = 0;
      for (const [k, v] of pms) {
        const parts = k.split('_');
        if (parts[1] === pid && parts[2] === cid) {
          goals += v.goals;
          assists += v.assists;
        }
      }
      players.set(`${pid}_${cid}`, { goals, assists });
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.clubs/i.test(sql) || /INSERT INTO public\.playercards/i.test(sql)) {
      return { rowCount: 1 };
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
        p1: { name: 'Player 1', position: 'ST', goals: 2, assists: 1 },
      },
    },
  };

  await saveEaMatch(match);
  await saveEaMatch(match);

  queryStub.mock.restore();
  const stats = players.get('p1_10');
  assert.deepStrictEqual(stats, { goals: 2, assists: 1 });
});

test('rebuildPlayerStats recomputes totals matching team goals', async () => {
  const players = new Map();
  const pms = new Map();
  const teamGoals = new Map();

  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.matches/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      const [mid, cid, , goals] = params;
      teamGoals.set(cid, goals);
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.players \(player_id, club_id, name, position, vproattr, goals, assists, last_seen\)/i.test(sql)) {
      if (/SELECT pm\.player_id/i.test(sql)) {
        const totals = {};
        for (const [k, v] of pms) {
          const parts = k.split('_');
          const key = `${parts[1]}_${parts[2]}`;
          if (!totals[key]) totals[key] = { goals: 0, assists: 0 };
          totals[key].goals += v.goals;
          totals[key].assists += v.assists;
        }
        for (const [key, val] of Object.entries(totals)) {
          players.set(key, val);
        }
        return { rowCount: Object.keys(totals).length };
      }
      const [pid, cid] = params;
      const key = `${pid}_${cid}`;
      if (!players.has(key)) players.set(key, { goals: 0, assists: 0 });
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.player_match_stats/i.test(sql)) {
      const [mid, pid, cid, g, a] = params;
      const key = `${mid}_${pid}_${cid}`;
      if (pms.has(key)) return { rowCount: 0 };
      pms.set(key, { goals: g, assists: a });
      return { rowCount: 1 };
    }
    if (/UPDATE public\.players p SET/i.test(sql)) {
      const [pid, cid] = params;
      let goals = 0, assists = 0;
      for (const [k, v] of pms) {
        const parts = k.split('_');
        if (parts[1] === pid && parts[2] === cid) {
          goals += v.goals;
          assists += v.assists;
        }
      }
      players.set(`${pid}_${cid}`, { goals, assists });
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.clubs/i.test(sql) || /INSERT INTO public\.playercards/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/SELECT/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    return { rowCount: 1 };
  });

  const match = {
    matchId: 'm3',
    timestamp: 1000,
    clubs: {
      '10': { details: { name: 'Alpha', isHome: 1 }, goals: 2 },
    },
    players: {
      '10': {
        p1: { name: 'Player 1', position: 'ST', goals: 2, assists: 0 },
      },
    },
  };

  await saveEaMatch(match);
  // Corrupt player totals
  players.set('p1_10', { goals: 0, assists: 0 });
  await rebuildPlayerStats();

  queryStub.mock.restore();
  const stats = players.get('p1_10');
  assert.strictEqual(stats.goals, teamGoals.get('10'));
});
