const { test, mock } = require('node:test');
const assert = require('assert');

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'test',
  client_email: 'test@test',
  private_key: 'key'
});
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

function firestore() { return {}; }
firestore.FieldValue = {};
firestore.FieldPath = {};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') {
    return {
      credential: { cert: svc => svc },
      initializeApp: () => {},
      apps: [],
      app: () => ({ options: { projectId: 'test' } }),
      firestore
    };
  }
  return originalRequire.apply(this, arguments);
};

const eaApi = require('../services/eaApi');
const app = require('../server');
Module.prototype.require = originalRequire;

async function withServer(fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(port);
  } finally {
    server.close();
  }
}

test('normalizes array response', async () => {
  const stub = mock.method(eaApi, 'fetchClubMembers', async () => [{ name: 'A' }]);
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/clubs/123/members`);
    const body = await res.json();
    assert.deepStrictEqual(body, { members: [{ name: 'A' }] });
  });
  stub.mock.restore();
});

test('normalizes object map response', async () => {
  const stub = mock.method(eaApi, 'fetchClubMembers', async () => ({ members: { a:{ name:'A'}, b:{ name:'B'} } }));
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/ea/clubs/123/members`);
    const body = await res.json();
    assert.deepStrictEqual(body, { members: [{ name: 'A' }, { name: 'B' }] });
  });
  stub.mock.restore();
});
