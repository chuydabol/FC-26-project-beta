const { test, mock } = require('node:test');
const assert = require('assert');

const pg = require('../services/pgwrap');
const { checkStatsIntegrity } = require('../services/statsIntegrity');

const mismatches = [
  { match_id: 1, club_id: 10, player_goals: 1, team_goals: 2 }
];

test('detects mismatched player and team goals', async () => {
  const stub = mock.method(pg, 'q', async sql => {
    assert.match(sql, /match_participants/i);
    assert.match(sql, /player_match_stats/i);
    return { rows: mismatches };
  });

  const rows = await checkStatsIntegrity();
  assert.deepStrictEqual(rows, mismatches);

  stub.mock.restore();
});

test('returns empty array when totals match', async () => {
  const stub = mock.method(pg, 'q', async () => ({ rows: [] }));
  const rows = await checkStatsIntegrity();
  assert.deepStrictEqual(rows, []);
  stub.mock.restore();
});
