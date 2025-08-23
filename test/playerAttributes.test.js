const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const { getPlayerAttributes } = require('../services/playerAttributes');

const sample = '1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26';

function expectedOvr() {
  const stats = { pac:2, sho:6, pas:11, dri:7, def:21, phy:25 }; // computed from sample
  const ovr = Math.round(
    stats.pac*0.2 + stats.sho*0.2 + stats.pas*0.2 +
    stats.dri*0.2 + stats.def*0.1 + stats.phy*0.1
  );
  return ovr; // should be 10
}

const ovr10 = expectedOvr();

test('getPlayerAttributes uses match data first', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/FROM public\.matches/i.test(sql)) {
      return { rows: [{ vproattr: sample }] };
    }
    throw new Error('should not query players table');
  });
  const stats = await getPlayerAttributes('p1', 'c1');
  assert.strictEqual(stats.ovr, ovr10);
  stub.mock.restore();
});

test('getPlayerAttributes falls back to players table', async () => {
  const stub = mock.method(pool, 'query', async sql => {
    if (/FROM public\.matches/i.test(sql)) {
      return { rows: [] };
    }
    if (/FROM public\.players/i.test(sql)) {
      return { rows: [{ vproattr: sample }] };
    }
    return { rows: [] };
  });
  const stats = await getPlayerAttributes('p1', 'c1');
  assert.strictEqual(stats.ovr, ovr10);
  stub.mock.restore();
});

test('getPlayerAttributes returns null when missing', async () => {
  const stub = mock.method(pool, 'query', async () => ({ rows: [] }));
  const stats = await getPlayerAttributes('p1', 'c1');
  assert.strictEqual(stats, null);
  stub.mock.restore();
});
