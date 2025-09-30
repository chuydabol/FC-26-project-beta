// Helper to determine if a position string matches any alias
function positionMatches(position = '', aliases = []) {
  const lower = position.toLowerCase();
  return aliases.some(alias => lower.includes(alias));
}

// Rewrite the rankings value system in rankings.js
// The goal is to make rankings fairer by including:
// - Performance (rating, goals, assists, clean sheets)
// - Consistency (win rate, contribution to team performance)
// - Activity (matches played multiplier)
// - Position-based weighting
// - A minimum matches requirement (e.g. 20 matches to qualify)

// 1. Create a helper function to calculate player value.
export function calculatePlayerValue(player = {}) {
  const matches = Number(player.gamesPlayed || player.matches || 0);
  if (Number.isNaN(matches) || matches < 20) {
    // not enough games, return 0 so they won't appear in rankings
    return 0;
  }

  const rating = Number(player.ratingAve ?? player.rating ?? 0) || 0;
  const winRate = Number(player.winRate ?? 0) || 0; // percent
  const goals = Number(player.goals ?? 0) || 0;
  const assists = Number(player.assists ?? 0) || 0;
  const cleanSheetsDef = Number(player.cleanSheetsDef ?? player.cleanSheets ?? 0) || 0;
  const cleanSheetsGK = Number(player.cleanSheetsGK ?? player.cleanSheets ?? 0) || 0;
  const tackles = Number(player.tacklesMade ?? player.tackles ?? 0) || 0;
  const position = String(player.favoritePosition ?? player.position ?? '').toLowerCase();

  // -------------------------
  // Performance score
  // -------------------------
  let performance = 0;

  // Base from average rating (out of 10)
  const normalizedRating = rating > 0 ? (rating / 10) * 100 : 0;
  performance += normalizedRating;

  // Position-based contribution
  if (positionMatches(position, ['forward', 'striker', 'st', 'cf', 'wing', 'lw', 'rw'])) {
    performance += goals * 4 + assists * 2;
  } else if (positionMatches(position, ['midfielder', 'mid', 'cm', 'cam', 'cdm', 'lm', 'rm'])) {
    performance += goals * 2.5 + assists * 3;
  } else if (positionMatches(position, ['defender', 'def', 'cb', 'lb', 'rb', 'rwb', 'lwb'])) {
    performance += tackles * 0.5 + cleanSheetsDef * 6;
  } else if (positionMatches(position, ['goalkeeper', 'gk', 'keeper'])) {
    performance += cleanSheetsGK * 8;
  } else {
    // Unknown roles: give a balanced contribution leaning on general stats
    performance += goals * 2 + assists * 2 + cleanSheetsDef * 3 + cleanSheetsGK * 4;
  }

  // -------------------------
  // Consistency score
  // -------------------------
  const consistency = winRate * 0.5 + rating * 5; // mix of win% and rating

  // -------------------------
  // Activity multiplier
  // -------------------------
  const activityMultiplier = Math.log10(matches + 1); // prevents spamming

  // -------------------------
  // Final Value
  // -------------------------
  const value = performance * consistency * activityMultiplier * 1000;

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.round(value); // round to nearest USD
}

// 2. Use this function inside the rankings mapping
export default function buildRankedPlayers(members = []) {
  return members
    .map(player => {
      const value = calculatePlayerValue(player);
      return {
        ...player,
        value,
        points: value / 10000, // optional points metric
      };
    })
    .filter(player => player.value > 0) // remove players under minimum games
    .sort((a, b) => b.value - a.value); // sort descending
}
