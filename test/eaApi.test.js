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


test('readMatchesPayload flattens nested duplicate EA match arrays', () => {
  const first = { matchId: '716874327810264', clubs: { 2924517: { goals: '0' }, 72600: { goals: '3' } } };
  const second = { matchId: '716774422480032', clubs: { 2924517: { goals: '2' }, 3485690: { goals: '3' } } };

  assert.deepEqual(readMatchesPayload([[first, second], [first]], '2924517'), [first, second]);
  assert.deepEqual(readMatchesPayload({ 2924517: [[first], [second, first]] }, '2924517'), [first, second]);
  assert.deepEqual(readMatchesPayload({ matches: [[first], [second]] }, '2924517'), [first, second]);
});
