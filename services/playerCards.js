function parseVpro(vproattr = '') {
  const parts = String(vproattr).split('|').map(n => parseInt(n, 10));
  const avg = arr => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  if (parts.length < 27) {
    return { pac: 0, sho: 0, pas: 0, dri: 0, def: 0, phy: 0, ovr: 0 };
  }
  const pac = avg([parts[0], parts[1]]);
  const sho = avg([parts[4], parts[5], parts[8], parts[16], parts[17]]);
  const pas = avg([parts[9], parts[19], parts[12], parts[15], parts[13]]);
  const dri = avg([parts[2], parts[3], parts[7], parts[11]]);
  const def = avg([parts[18], parts[10], parts[20], parts[21]]);
  const phy = avg([parts[22], parts[23], parts[24], parts[25], parts[26]]);
  const ovr = Math.round(
    pac * 0.2 +
    sho * 0.2 +
    pas * 0.2 +
    dri * 0.2 +
    def * 0.1 +
    phy * 0.1
  );
  return { pac, sho, pas, dri, def, phy, ovr };
}

function tierFromOvr(ovr = 0) {
  const n = Number(ovr) || 0;
  if (n < 70) {
    return { frame: 'iron_rookie.png', className: 'tier-iron' };
  }
  if (n <= 84) {
    return { frame: 'steel_card.png', className: 'tier-steel' };
  }
  if (n <= 94) {
    return { frame: 'crimson_card.png', className: 'tier-crimson' };
  }
  return { frame: 'obsidian_elite.png', className: 'tier-obsidian' };
}

function tierFromStats(
  { ovr = 0, matches = 0, goals = 0, assists = 0, isCaptain = false },
  topOvrThreshold = Infinity
) {
  if (!ovr || matches < 5) {
    return { tier: 'iron', frame: 'iron_rookie.png', className: 'tier-iron' };
  }
  if (isCaptain || ovr >= topOvrThreshold) {
    return { tier: 'obsidian', frame: 'obsidian_elite.png', className: 'tier-obsidian' };
  }
  const ga = Number(goals) + Number(assists);
  if (ga > 10) {
    return { tier: 'crimson', frame: 'crimson_card.png', className: 'tier-crimson' };
  }
  if (matches >= 5) {
    return { tier: 'steel', frame: 'steel_card.png', className: 'tier-steel' };
  }
  return { tier: 'iron', frame: 'iron_rookie.png', className: 'tier-iron' };
}

module.exports = { parseVpro, tierFromStats, tierFromOvr };
