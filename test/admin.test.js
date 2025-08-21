const { test } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
process.env.ADMIN_PASSWORD = 'secret';
process.env.SESSION_SECRET = 'test-secret';

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

test('admin login lifecycle', async () => {
  await withServer(async port => {
    // not signed in
    let res = await fetch(`http://localhost:${port}/api/admin/me`);
    let body = await res.json();
    assert.deepStrictEqual(body, { admin: false });

    // login
    res = await fetch(`http://localhost:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'secret' })
    });
    assert.strictEqual(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];

    // verify session
    res = await fetch(`http://localhost:${port}/api/admin/me`, {
      headers: { cookie }
    });
    body = await res.json();
    assert.deepStrictEqual(body, { admin: true });

    // logout
    res = await fetch(`http://localhost:${port}/api/admin/logout`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.strictEqual(res.status, 200);

    res = await fetch(`http://localhost:${port}/api/admin/me`, {
      headers: { cookie }
    });
    body = await res.json();
    assert.deepStrictEqual(body, { admin: false });
  });
});

