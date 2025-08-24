const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { q } = require('../services/pgwrap');
const { pool } = require('../db');

const SQL_UPSERT_PLAYER = `
  INSERT INTO public.players (player_id, club_id, name, position, goals, assists, last_seen)
  VALUES ($1, $2, $3, $4, $5, $6, NOW())
  ON CONFLICT (player_id, club_id)
  DO UPDATE SET
    name = EXCLUDED.name,
    position = EXCLUDED.position,
    goals = EXCLUDED.goals,
    assists = EXCLUDED.assists,
    last_seen = NOW();
`;

test('upserts player per club without 42P10 and updates attributes', async () => {
  const store = new Map();
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.players/i.test(sql)) {
      const key = `${params[0]}:${params[1]}`;
      if (store.has(key) && !/ON CONFLICT \(player_id, club_id\)/i.test(sql)) {
        const err = new Error('missing conflict clause');
        err.code = '42P10';
        throw err;
      }
      const [pid, cid, name, position, goals, assists] = params;
      store.set(key, { pid, cid, name, position, goals, assists });
    }
    return { rows: [] };
  });

  await q(SQL_UPSERT_PLAYER, ['1', '10', 'Alice', 'ST', 1, 2]);
  await q(SQL_UPSERT_PLAYER, ['1', '10', 'Alicia', 'CM', 3, 4]);

  queryStub.mock.restore();
  const row = store.get('1:10');
  assert.strictEqual(row.name, 'Alicia');
  assert.strictEqual(row.goals, 3);
});
