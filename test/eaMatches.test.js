const { test, mock } = require('node:test');
const assert = require('assert');

const app = require('../server');

async function withServer(fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('fetches matches for a single club', async () => {
  const fake = { '111': [{ matchId: '1' }] };
  const stub = mock.method(global, 'fetch', async url => {
    assert.ok(url.includes('clubIds=111'));
    return { ok: true, json: async () => fake };
  });

  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/matches/111`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, fake['111']);
  });

  stub.mock.restore();
});
