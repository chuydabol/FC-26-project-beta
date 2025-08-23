const { test } = require('node:test');
const assert = require('assert');
const { parseVpro, tierFromStats } = require('../services/playerCards');

test('parseVpro computes stats and overall', () => {
  const attrs = '091|094|094|089|072|084|064|095|066|093|064|089|091|094|082|095|083|079|068|089|091|069|091|082|067|065|075|090|077|010|010|010|010|010';
  const stats = parseVpro(attrs);
  assert.deepStrictEqual(stats, {
    pac: 93,
    sho: 73,
    pas: 83,
    dri: 85,
    def: 90,
    phy: 71,
    ovr: 83
  });
});


test('parseVpro tolerates missing attributes', () => {
  const stats = parseVpro(null);
  assert.deepStrictEqual(stats, {
    pac: 0,
    sho: 0,
    pas: 0,
    dri: 0,
    def: 0,
    phy: 0,
    ovr: 0
  });
});

test('tierFromStats maps to expected tiers', () => {
  assert.strictEqual(tierFromStats({ ovr: 60, matches: 2 }).tier, 'iron');
  assert.strictEqual(tierFromStats({ ovr: 80, matches: 10 }).tier, 'steel');
  assert.strictEqual(tierFromStats({ ovr: 88, matches: 12, goals: 6, assists: 6 }).tier, 'crimson');
  assert.strictEqual(tierFromStats({ ovr: 99, matches: 20 }, 90).tier, 'obsidian');
});
