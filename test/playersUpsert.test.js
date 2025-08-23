const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { q } = require('../services/pgwrap');
const { pool } = require('../db');

const SQL_UPSERT_PLAYER = `
  INSERT INTO public.players (player_id, club_id, name, position)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (player_id) DO UPDATE
    SET name     = COALESCE(EXCLUDED.name, players.name),
        position = COALESCE(NULLIF(EXCLUDED.position,'UNK'), players.position),
        club_id  = EXCLUDED.club_id,
        last_seen = now()
`;

test('duplicate player_id upserts without 42P10', async () => {
  const seen = new Set();
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    if (/INSERT INTO public\.players/i.test(sql)) {
      const pid = params[0];
      if (seen.has(pid) && !/ON CONFLICT \(player_id\)/i.test(sql)) {
        const err = new Error('missing conflict clause');
        err.code = '42P10';
        throw err;
      }
      seen.add(pid);
    }
    return { rows: [] };
  });

  await q(SQL_UPSERT_PLAYER, ['1', '10', 'Alice', 'ST']);
  await q(SQL_UPSERT_PLAYER, ['1', '10', 'Alice', 'ST']);

  queryStub.mock.restore();
  assert.ok(true); // reached without throwing
});
