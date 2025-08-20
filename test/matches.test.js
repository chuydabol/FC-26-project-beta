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

const pool = require('../db');
const queryStub = mock.method(pool, 'query', async sql => {
  if (/FROM matches/i.test(sql)) {
    return {
      rows: [
        { id: 1, timestamp: '2024-01-01T00:00:00Z', clubs: {}, players: {} }
      ]
    };
  }
  return { rows: [] };
});

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

test('serves recent matches from db', async () => {
  await withServer(async port => {
    const res = await fetch(`http://localhost:${port}/api/matches`);
    const body = await res.json();
    assert.deepStrictEqual(body, {
      matches: [{ id: 1, timestamp: '2024-01-01T00:00:00Z', clubs: {}, players: {} }]
    });
  });
  queryStub.mock.restore();
});
