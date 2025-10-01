const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const { saveEaMatch } = require('../server');
const eaApi = require('../services/eaApi');
const { rebuildPlayerStats } = require('../scripts/rebuildPlayerStats');

const LEAGUE_START_SEC = Date.parse('2025-08-27T23:59:00-07:00') / 1000;

test('saveEaMatch stores home/away flags for clubs', async () => {
  const divisionStub = mock.method(eaApi, 'fetchClubDivisionByName', async name => {
    if (name === 'Alpha') return 2;
    if (name === 'Beta') return 4;
    return null;
  });
  const calls = [];
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      calls.push(params);
    }
    return { rows: [], rowCount: 1 };
  });

  try {
    const match = {
      matchId: 'm1',
      timestamp: LEAGUE_START_SEC + 60,
      clubs: {
        '10': { details: { name: 'Alpha', isHome: 1 }, goals: 3 },
        '20': { details: { name: 'Beta', isHome: 0 }, goals: 1 },
      },
    };

    await saveEaMatch(match);

    assert.deepStrictEqual(calls, [
      ['m1', '10', true, 3],
      ['m1', '20', false, 1],
    ]);
  } finally {
    queryStub.mock.restore();
    divisionStub.mock.restore();
  }
});

test('saveEaMatch infers home/away flags when missing', async () => {
  const divisionStub = mock.method(eaApi, 'fetchClubDivisionByName', async () => null);
  const calls = [];
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      calls.push(params);
    }
    return { rows: [], rowCount: 1 };
  });

  try {
    const match = {
      matchId: 'm1-missing',
      timestamp: LEAGUE_START_SEC + 90,
      clubs: {
        '10': { details: { name: 'Alpha' }, goals: 2 },
        '20': { details: { name: 'Beta' }, goals: 1 },
      },
    };

    await saveEaMatch(match);

    assert.strictEqual(calls.length, 2);
    const homeRecord = calls.find(([, cid]) => cid === '10');
    const awayRecord = calls.find(([, cid]) => cid === '20');
    assert.ok(homeRecord, 'expected a participant record for club 10');
    assert.ok(awayRecord, 'expected a participant record for club 20');
    assert.strictEqual(homeRecord[2], true);
    assert.strictEqual(awayRecord[2], false);
    const trueCount = calls.filter(([, , isHome]) => isHome === true).length;
    assert.strictEqual(trueCount, 1);
  } finally {
    queryStub.mock.restore();
    divisionStub.mock.restore();
  }
});

test('saveEaMatch persists club divisions from leaderboard search', async () => {
  const divisionStub = mock.method(eaApi, 'fetchClubDivisionByName', async name => {
    if (name === 'Alpha') return 5;
    if (name === 'Beta') return 7;
    return null;
  });
  const matchesParams = [];
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.matches/i.test(sql)) {
      matchesParams.push(params);
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.clubs/i.test(sql)) {
      return { rowCount: 1 };
    }
    return { rowCount: 1 };
  });

  try {
    const match = {
      matchId: 'div1',
      timestamp: LEAGUE_START_SEC + 240,
      clubs: {
        '1': { details: { name: 'Alpha', isHome: 1 }, goals: 4 },
        '2': { details: { name: 'Beta', isHome: 0 }, goals: 3 },
      },
    };

    await saveEaMatch(match);
  } finally {
    queryStub.mock.restore();
    divisionStub.mock.restore();
  }

  assert.strictEqual(matchesParams.length, 1);
  const params = matchesParams[0];
  assert.strictEqual(params[3], 5);
  assert.strictEqual(params[4], 7);
});

test('saveEaMatch normalizes string and boolean home flags', async () => {
  const divisionStub = mock.method(eaApi, 'fetchClubDivisionByName', async () => 1);
  const calls = [];
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      calls.push(params);
    }
    return { rows: [], rowCount: 1 };
  });

  try {
    const matches = [
      {
        matchId: 'm1b',
        timestamp: LEAGUE_START_SEC + 120,
        clubs: {
          '30': { details: { name: 'Gamma', isHome: 'true' }, goals: 2 },
          '40': { details: { name: 'Delta', isHome: 'false' }, goals: 2 },
        },
      },
      {
        matchId: 'm1c',
        timestamp: LEAGUE_START_SEC + 180,
        clubs: {
          '50': { details: { name: 'Epsilon', isHome: 'home' }, goals: 1 },
          '60': { details: { name: 'Zeta', isHome: false }, goals: 3 },
        },
      },
    ];

    for (const match of matches) {
      await saveEaMatch(match);
    }

    assert.deepStrictEqual(calls, [
      ['m1b', '30', true, 2],
      ['m1b', '40', false, 2],
      ['m1c', '50', true, 1],
      ['m1c', '60', false, 3],
    ]);
  } finally {
    queryStub.mock.restore();
    divisionStub.mock.restore();
  }
});

test('saveEaMatch skips matches before league start', async () => {
  const queryStub = mock.method(pool, 'query', async () => {
    throw new Error('should not query');
  });

  const match = { matchId: 'm0', timestamp: LEAGUE_START_SEC - 60 };
  await saveEaMatch(match);

  assert.strictEqual(queryStub.mock.calls.length, 0);
  queryStub.mock.restore();
});

test('duplicate saveEaMatch calls do not double-count player stats', async () => {
  const divisionStub = mock.method(eaApi, 'fetchClubDivisionByName', async name =>
    name === 'Alpha' ? 2 : null
  );
  const players = new Map();
  const pms = new Map();

  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.matches/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.match_participants/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/INSERT INTO public\.players/i.test(sql)) {
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
    timestamp: LEAGUE_START_SEC + 60,
    clubs: {
      '10': { details: { name: 'Alpha', isHome: 1 }, goals: 1 },
    },
    players: {
      '10': {
        p1: { name: 'Player 1', position: 'ST', goals: 2, assists: 1 },
      },
    },
  };

  try {
    await saveEaMatch(match);
    await saveEaMatch(match);
  } finally {
    queryStub.mock.restore();
    divisionStub.mock.restore();
  }

  const stats = players.get('p1_10');
  assert.deepStrictEqual(stats, { goals: 2, assists: 1 });
});

test('rebuildPlayerStats recomputes totals matching team goals', async () => {
  const divisionStub = mock.method(eaApi, 'fetchClubDivisionByName', async name =>
    name === 'Alpha' ? 3 : null
  );
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
    if (/INSERT INTO public\.players/i.test(sql)) {
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
    timestamp: LEAGUE_START_SEC + 60,
    clubs: {
      '10': { details: { name: 'Alpha', isHome: 1 }, goals: 2 },
    },
    players: {
      '10': {
        p1: { name: 'Player 1', position: 'ST', goals: 2, assists: 0 },
      },
    },
  };

  try {
    await saveEaMatch(match);
    // Corrupt player totals
    players.set('p1_10', { goals: 0, assists: 0 });
    await rebuildPlayerStats();
  } finally {
    queryStub.mock.restore();
    divisionStub.mock.restore();
  }

  const stats = players.get('p1_10');
  assert.strictEqual(stats.goals, teamGoals.get('10'));
});
