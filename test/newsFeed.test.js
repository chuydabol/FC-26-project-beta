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

test('auto standings card excludes clubs outside the league', async () => {
  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/FROM public\.news/i.test(sql)) {
      return { rows: [] };
    }
    if (/FROM public\.upcl_standings/i.test(sql)) {
      assert.match(sql, /club_id::bigint = ANY\(\$1::bigint\[\]\)/i);
      assert.deepStrictEqual(params, [[1]]);
      return {
        rows: [
          {
            club_id: 1,
            pts: 22,
            w: 7,
            d: 1,
            l: 2,
            gf: 25,
            ga: 15,
            gd: 10,
            updated_at: new Date('2024-01-01T00:00:00Z')
          },
          {
            club_id: 999,
            pts: 30,
            w: 10,
            d: 0,
            l: 0,
            gf: 40,
            ga: 0,
            gd: 40,
            updated_at: new Date('2024-01-02T00:00:00Z')
          }
        ]
      };
    }
    if (/FROM public\.upcl_leaders/i.test(sql)) {
      return { rows: [] };
    }
    if (/FROM public\.matches m/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/news`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const mainFeed = Array.isArray(body.main) ? body.main : body.items;
    const standingsCard = mainFeed.find(item => item.id === 'auto-standings');
    assert(standingsCard, 'expected auto standings card');
    assert.deepStrictEqual(standingsCard.stats.map(s => s.clubId), ['1']);
    assert.strictEqual(standingsCard.stats.length, 1);
    assert(Array.isArray(body.general));
  });

  stub.mock.restore();
});

test('admin can delete manual news', async () => {
  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/DELETE FROM public\.news/i.test(sql)) {
      assert.deepStrictEqual(params, [42]);
      return { rowCount: 1, rows: [{ id: 42 }] };
    }
    if (/FROM public\.news/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  try {
    await withServer(async port => {
      const login = await fetch(`http://localhost:${port}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'admin' })
      });
      assert.strictEqual(login.status, 200);
      const cookie = login.headers.get('set-cookie');
      assert(cookie, 'expected session cookie');
      await login.json();

      const res = await fetch(`http://localhost:${port}/api/news/42`, {
        method: 'DELETE',
        headers: { cookie }
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { ok: true });
    });
  } finally {
    stub.mock.restore();
  }
});

test('deleting manual news requires admin session', async () => {
  let deleteCalled = false;
  const stub = mock.method(pool, 'query', async (sql, params) => {
    if (/DELETE FROM public\.news/i.test(sql)) {
      deleteCalled = true;
      return { rowCount: 1, rows: [{ id: Number(params?.[0]) || 0 }] };
    }
    if (/FROM public\.news/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  try {
    await withServer(async port => {
      const res = await fetch(`http://localhost:${port}/api/news/42`, { method: 'DELETE' });
      assert.strictEqual(res.status, 403);
    });
    assert.strictEqual(deleteCalled, false);
  } finally {
    stub.mock.restore();
  }
});
