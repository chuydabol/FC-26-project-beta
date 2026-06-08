const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeClubId, readMatchesPayload } = require('../services/eaApi');

test('normalizeClubId accepts numeric club ids', () => {
  assert.equal(normalizeClubId('57985'), '57985');
  assert.equal(normalizeClubId(57985), '57985');
});

test('normalizeClubId rejects non-numeric club ids', () => {
  assert.throws(() => normalizeClubId('bota'), /numeric/);
});

test('readMatchesPayload accepts EA array, keyed, and matches payloads', () => {
  const match = { matchId: '1' };
  assert.deepEqual(readMatchesPayload([match], '57985'), [match]);
  assert.deepEqual(readMatchesPayload({ 57985: [match] }, '57985'), [match]);
  assert.deepEqual(readMatchesPayload({ matches: [match] }, '57985'), [match]);
  assert.deepEqual(readMatchesPayload({}, '57985'), []);
});
