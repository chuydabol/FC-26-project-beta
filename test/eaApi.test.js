const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeClubId, normalizeMembersStats, readMatchesPayload, readMembersPayload } = require('../services/eaApi');

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


test('readMembersPayload reads EA members stats payload', () => {
  const body = { members: [{ name: 'UPCL Striker' }], positionCount: { ST: 1 } };
  assert.deepEqual(readMembersPayload(body), body);
  assert.deepEqual(readMembersPayload(null), { members: [], positionCount: {} });
});

test('normalizeMembersStats converts EA member values to API-friendly numbers', () => {
  const normalized = normalizeMembersStats({
    members: [{
      name: 'UPCL Striker',
      gamesPlayed: '12',
      winRate: '66.7',
      goals: '9',
      assists: '4',
      passesMade: '110',
      passSuccessRate: '81.5',
      ratingAve: '8.2',
      tacklesMade: '7',
      tackleSuccessRate: '55.5',
      manOfTheMatch: '3',
      redCards: '1',
      favoritePosition: 'ST',
      proName: 'Finisher',
      proOverall: '91',
      proOverallStr: '91',
    }],
    positionCount: { ST: 1 },
  });

  assert.equal(normalized.members[0].name, 'UPCL Striker');
  assert.equal(normalized.members[0].gamesPlayed, 12);
  assert.equal(normalized.members[0].winRate, 66.7);
  assert.equal(normalized.members[0].ratingAve, 8.2);
  assert.equal(normalized.members[0].proOverall, 91);
  assert.deepEqual(normalized.positionCount, { ST: 1 });
});
