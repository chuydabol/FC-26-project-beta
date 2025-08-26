const { test, mock } = require('node:test');
const assert = require('assert');
const path = require('path');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.LEAGUE_CLUBS_PATH = path.join(__dirname, 'fixtures', 'leagueClubs.json');
process.env.DEFAULT_LEAGUE_ID = 'test';

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

test('serves league standings table', async () => {
  const matchRows = [{
    raw: {
      clubs: {
        '1': { wins: '0', losses: '1', ties: '0', goals: '2', score: '2' },
        '2': { wins: '1', losses: '0', ties: '0', goals: '3', score: '3' }
      }
    }
  }];

  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/jsonb_object_keys/i.test(sql)) {
      assert.match(sql, /WHERE cid = ANY\(\$1\)/i);
      assert.deepStrictEqual(params, [['1']]);

      const stats = new Map();
      for (const m of matchRows) {
        const clubs = m.raw.clubs;
        for (const [cid, data] of Object.entries(clubs)) {
          if (!stats.has(cid)) {
            stats.set(cid, { club_id: cid, wins: 0, losses: 0, draws: 0, goals_for: 0, goals_against: 0, points: 0 });
          }
          const row = stats.get(cid);
          const gf = parseInt(data.goals || data.score || '0', 10);
          const oppId = Object.keys(clubs).find(id => id !== cid);
          const opp = clubs[oppId];
          const ga = parseInt(opp.goals || opp.score || '0', 10);
          const w = parseInt(data.wins || '0', 10);
          const l = parseInt(data.losses || '0', 10);
          const d = parseInt(data.ties || '0', 10);
          row.wins += w;
          row.losses += l;
          row.draws += d;
          row.goals_for += gf;
          row.goals_against += ga;
          row.points += w * 3 + d;
        }
      }

      const rows = Array.from(stats.values()).filter(r => params[0].includes(r.club_id));
      return { rows };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/league`);
    const body = await res.json();
    assert.notStrictEqual(body.standings[0].goals_for, body.standings[0].goals_against);
    assert.strictEqual(body.standings[0].goals_for, 2);
    assert.strictEqual(body.standings[0].goals_against, 3);
    assert.deepStrictEqual(body, {
      standings: [
        { club_id: '1', wins: 0, losses: 1, draws: 0, goals_for: 2, goals_against: 3, points: 0 }
      ]
    });
  });

  stub.mock.restore();
});
