const { test } = require('node:test');
const assert = require('assert');
const { hasDuplicates, uniqueStrings } = require('../utils');

test('hasDuplicates detects duplicates', () => {
  assert.strictEqual(hasDuplicates(['1','2','2']), true);
  assert.strictEqual(hasDuplicates(['1','2','3']), false);
});

test('uniqueStrings strips duplicates and preserves originals', () => {
  assert.deepStrictEqual(uniqueStrings([1,'1',2]), [1,2]);
});

test('duplicate ids across groups are detected', () => {
  const groups = {
    A: ['1','2'],
    B: ['3','1'],
    C: [],
    D: []
  };
  const docGroups = {
    A: uniqueStrings(groups.A),
    B: uniqueStrings(groups.B),
    C: uniqueStrings(groups.C),
    D: uniqueStrings(groups.D)
  };
  const all = [...docGroups.A, ...docGroups.B, ...docGroups.C, ...docGroups.D];
  assert.strictEqual(hasDuplicates(all), true);
});

test('formatted ids normalize to detect duplicates', () => {
  const variants = ['Elite-xi', 'elite xi'];
  assert.strictEqual(hasDuplicates(variants), true);
  assert.deepStrictEqual(uniqueStrings(variants), ['Elite-xi']);
});
