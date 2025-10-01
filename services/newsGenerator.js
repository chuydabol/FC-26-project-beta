const path = require('path');
const logger = require('../logger');
const { q } = require('./pgwrap');
const newsRepo = require('./newsRepository');
const { renderImage, renderCard } = require('./newsMedia');

const AUTO_EXPIRY_MS = 24 * 60 * 60 * 1000;
const MATCH_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const STREAK_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const FORM_LOOKBACK_MATCHES = 8;
const AUTO_BATCH_TARGET = 9;

const SQL_STANDINGS = `
  SELECT club_id,
         points AS pts,
         wins AS w,
         draws AS d,
         losses AS l,
         goals_for AS gf,
         goals_against AS ga,
         goal_diff AS gd,
         CURRENT_TIMESTAMP AS updated_at,
         ROW_NUMBER() OVER (ORDER BY points DESC, goal_diff DESC, goals_for DESC) AS rank
    FROM public.mv_league_standings
   WHERE $1::bigint[] IS NULL OR club_id::bigint = ANY($1::bigint[])
   ORDER BY points DESC, goal_diff DESC, goals_for DESC
`;

const SQL_CLUBS = `
  SELECT club_id, club_name
    FROM public.clubs
`;

const SQL_LEADERS = `
  SELECT type,
         club_id,
         name,
         count
    FROM public.upcl_leaders
`;

const SQL_RECENT_MATCHES = `
  SELECT m.match_id,
         m.ts_ms,
         m.home_division,
         m.away_division,
         home.club_id AS home_id,
         away.club_id AS away_id,
         home.goals    AS home_goals,
         away.goals    AS away_goals
    FROM public.matches m
    JOIN public.match_participants home
      ON home.match_id = m.match_id AND home.is_home = true
    JOIN public.match_participants away
      ON away.match_id = m.match_id AND away.is_home = false
   WHERE m.ts_ms >= $1
   ORDER BY m.ts_ms DESC
   LIMIT 400
`;

const SQL_RECENT_PLAYER_STATS = `
  SELECT pms.match_id,
         pms.player_id,
         pms.club_id,
         pms.goals,
         pms.assists,
         pms.cleansheetsany,
         pms.saves,
         pms.rating,
         pms.mom,
         m.ts_ms,
         p.name,
         p.position
    FROM public.player_match_stats pms
    JOIN public.matches m ON m.match_id = pms.match_id
    JOIN public.players p ON p.player_id = pms.player_id AND p.club_id = pms.club_id
   WHERE m.ts_ms >= $1
`;

const SQL_PLAYER_TOTALS = `
  SELECT player_id,
         club_id,
         name,
         position,
         goals,
         assists,
         realtimegame,
         last_seen
    FROM public.players
`;

function ms(value) {
  return Number(value) || 0;
}

function fmtNumber(num) {
  if (!num) return '0';
  if (Math.abs(num) >= 1000) {
    return `${(num / 1000).toFixed(num % 1000 === 0 ? 0 : 1)}k`;
  }
  return String(num);
}

function fmtDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function fmtRelative(date, nowMs) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const diff = nowMs - d.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function pick(array, fallback) {
  if (!Array.isArray(array) || !array.length) return fallback;
  return array[Math.floor(Math.random() * array.length)];
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const LEAGUE_CLUBS_PATH = process.env.LEAGUE_CLUBS_PATH || path.join(__dirname, '..', 'data', 'leagueClubs.json');
let LEAGUE_CLUBS = {};
try {
  LEAGUE_CLUBS = require(LEAGUE_CLUBS_PATH);
} catch {
  LEAGUE_CLUBS = {};
}

const DEFAULT_LEAGUE_ID = process.env.DEFAULT_LEAGUE_ID || 'UPCL_LEAGUE_2025';

function normalizeClubIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids
    .map(id => {
      const num = Number(String(id ?? '').trim());
      return Number.isFinite(num) ? num : null;
    })
    .filter(id => id !== null);
}

function clubsForLeague(id) {
  return normalizeClubIds(LEAGUE_CLUBS[id] || []);
}

function resolveClubIds() {
  let ids = clubsForLeague(DEFAULT_LEAGUE_ID);
  if (!ids.length) {
    ids = normalizeClubIds(
      (process.env.EA_CLUB_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
  }
  return ids;
}

async function fetchContext(nowMs) {
  const sinceMatches = nowMs - MATCH_LOOKBACK_MS;
  const sinceStreak = nowMs - STREAK_LOOKBACK_MS;
  const leagueClubIds = resolveClubIds();
  const standingsParams = leagueClubIds.length ? leagueClubIds : null;
  const [standingsRes, leadersRes, clubsRes, matchesRes, playerStatsRes, playerTotalsRes] = await Promise.all([
    q(SQL_STANDINGS, [standingsParams]).catch(() => ({ rows: [] })),
    q(SQL_LEADERS).catch(() => ({ rows: [] })),
    q(SQL_CLUBS).catch(() => ({ rows: [] })),
    q(SQL_RECENT_MATCHES, [sinceMatches]).catch(() => ({ rows: [] })),
    q(SQL_RECENT_PLAYER_STATS, [sinceStreak]).catch(() => ({ rows: [] })),
    q(SQL_PLAYER_TOTALS).catch(() => ({ rows: [] }))
  ]);

  const clubs = new Map();
  (clubsRes.rows || []).forEach(row => {
    clubs.set(String(row.club_id), row.club_name || `Club ${row.club_id}`);
  });

  const standingsRaw = (standingsRes.rows || []).map(row => ({
    clubId: String(row.club_id),
    pts: Number(row.pts || 0),
    w: Number(row.w || row.wins || 0),
    d: Number(row.d || row.draws || 0),
    l: Number(row.l || row.losses || 0),
    gf: Number(row.gf || row.goals_for || 0),
    ga: Number(row.ga || row.goals_against || 0),
    gd: Number(row.gd || row.goal_diff || 0),
    rank: Number(row.rank || row.rn || 0),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  })).sort((a, b) => a.rank - b.rank);

  const allowedClubs = new Set((leagueClubIds || []).map(id => String(id)));
  const standings = allowedClubs.size
    ? standingsRaw.filter(row => allowedClubs.has(row.clubId))
    : standingsRaw;

  const rankMap = new Map();
  standings.forEach(row => {
    rankMap.set(row.clubId, row.rank || 999);
  });

  const leaders = (leadersRes.rows || []).map(row => ({
    type: row.type,
    clubId: String(row.club_id || ''),
    name: row.name,
    count: Number(row.count || 0)
  }));

  const matches = (matchesRes.rows || []).map(row => {
    const homeGoals = Number(row.home_goals || 0);
    const awayGoals = Number(row.away_goals || 0);
    let winner = null;
    let loser = null;
    let winnerGoals = homeGoals;
    let loserGoals = awayGoals;
    if (homeGoals > awayGoals) {
      winner = String(row.home_id);
      loser = String(row.away_id);
      winnerGoals = homeGoals;
      loserGoals = awayGoals;
    } else if (awayGoals > homeGoals) {
      winner = String(row.away_id);
      loser = String(row.home_id);
      winnerGoals = awayGoals;
      loserGoals = homeGoals;
    }
    return {
      matchId: String(row.match_id),
      ts: Number(row.ts_ms || 0),
      home: {
        clubId: String(row.home_id),
        goals: homeGoals
      },
      away: {
        clubId: String(row.away_id),
        goals: awayGoals
      },
      winner,
      loser,
      winnerGoals,
      loserGoals,
      division: {
        home: row.home_division || null,
        away: row.away_division || null
      }
    };
  }).sort((a, b) => b.ts - a.ts);

  const matchesByClub = new Map();
  matches.forEach(match => {
    const add = (clubId, goalsFor, goalsAgainst, isHome) => {
      if (!clubId) return;
      const key = String(clubId);
      if (!matchesByClub.has(key)) matchesByClub.set(key, []);
      matchesByClub.get(key).push({
        matchId: match.matchId,
        ts: match.ts,
        goalsFor,
        goalsAgainst,
        isHome,
        opponent: isHome ? match.away.clubId : match.home.clubId
      });
    };
    add(match.home.clubId, match.home.goals, match.away.goals, true);
    add(match.away.clubId, match.away.goals, match.home.goals, false);
  });

  const playerStats = (playerStatsRes.rows || []).map(row => ({
    matchId: String(row.match_id),
    playerId: String(row.player_id),
    clubId: String(row.club_id),
    goals: Number(row.goals || 0),
    assists: Number(row.assists || 0),
    cleanSheets: Number(row.cleansheetsany || 0),
    saves: Number(row.saves || 0),
    rating: Number(row.rating || 0),
    mom: Number(row.mom || 0),
    ts: Number(row.ts_ms || 0),
    name: row.name || 'Unknown Player',
    position: (row.position || '').toUpperCase()
  })).sort((a, b) => b.ts - a.ts);

  const statsByPlayer = new Map();
  playerStats.forEach(stat => {
    const key = `${stat.playerId}:${stat.clubId}`;
    if (!statsByPlayer.has(key)) statsByPlayer.set(key, []);
    statsByPlayer.get(key).push(stat);
  });

  const playerTotals = (playerTotalsRes.rows || []).map(row => ({
    playerId: String(row.player_id),
    clubId: String(row.club_id),
    name: row.name || 'Unknown Player',
    position: (row.position || '').toUpperCase(),
    goals: Number(row.goals || 0),
    assists: Number(row.assists || 0),
    matches: Number(row.realtimegame || 0),
    lastSeen: row.last_seen instanceof Date ? row.last_seen.toISOString() : row.last_seen
  }));

  return {
    nowMs,
    standings,
    rankMap,
    leaders,
    clubs,
    matches,
    matchesByClub,
    playerStats,
    statsByPlayer,
    playerTotals,
    leagueClubIds
  };
}

function clubName(ctx, clubId) {
  if (!clubId) return 'Unknown Club';
  return ctx.clubs.get(String(clubId)) || `Club ${clubId}`;
}

function buildLines(items, format) {
  return items.map(format);
}

async function buildStandingsSnapshot(ctx) {
  const top = ctx.standings.slice(0, 5);
  if (!top.length) return null;
  const subtitle = `Top clubs • ${fmtRelative(top[0].updatedAt, ctx.nowMs) || fmtDateTime(top[0].updatedAt)}`;
  const mediaUrl = await renderImage({
    title: 'Standings Snapshot',
    subtitle,
    labels: top.map(row => clubName(ctx, row.clubId)),
    values: top.map(row => row.pts),
    accentColor: '#facc15',
    background: ['#020617', '#111827', '#0f172a']
  });
  const stats = top.map(row => ({
    rank: row.rank,
    clubId: row.clubId,
    points: row.pts,
    record: `${row.w}-${row.d}-${row.l}`,
    goalDiff: row.gd
  }));
  const lines = stats.map(stat => `#${stat.rank} ${clubName(ctx, stat.clubId)} — ${stat.points} pts (GD ${stat.goalDiff})`);
  return {
    type: 'auto',
    title: 'Standings Snapshot',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'standings_snapshot',
      badge: 'Standings',
      lines,
      updatedAt: top[0].updatedAt,
      stats
    },
    stats
  };
}

async function buildGoalLeaders(ctx) {
  const scorers = ctx.leaders.filter(l => l.type === 'scorer').slice(0, 5);
  if (!scorers.length) return null;
  const mediaUrl = await renderImage({
    title: 'Golden Boot Race',
    subtitle: 'Top scorers',
    labels: scorers.map(s => s.name),
    values: scorers.map(s => s.count),
    accentColor: '#f97316',
    background: ['#02111f', '#111827', '#1f2937']
  });
  const lines = scorers.map((s, idx) => `${idx + 1}. ${s.name} (${clubName(ctx, s.clubId)}) — ${s.count} goals`);
  return {
    type: 'auto',
    title: 'Golden Boot Race',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'goal_leaders',
      badge: 'Goal Leaders',
      lines
    }
  };
}

async function buildAssistLeaders(ctx) {
  const assists = ctx.leaders.filter(l => l.type === 'assister').slice(0, 5);
  if (!assists.length) return null;
  const mediaUrl = await renderImage({
    title: 'Playmaker Board',
    subtitle: 'Top assist providers',
    labels: assists.map(s => s.name),
    values: assists.map(s => s.count),
    accentColor: '#38bdf8',
    background: ['#020617', '#0b1120', '#1e293b']
  });
  const lines = assists.map((s, idx) => `${idx + 1}. ${s.name} (${clubName(ctx, s.clubId)}) — ${s.count} assists`);
  return {
    type: 'auto',
    title: 'Assist Kings of the Day',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'assist_leaders',
      badge: 'Assist Leaders',
      lines
    }
  };
}

async function buildCleanSheetLeaders(ctx) {
  const keeperStats = [];
  ctx.playerStats.forEach(stat => {
    if (!stat.cleanSheets) return;
    if (!['GK', 'G', 'GOALKEEPER'].includes(stat.position)) return;
    const key = `${stat.playerId}:${stat.clubId}`;
    let rec = keeperStats.find(k => k.key === key);
    if (!rec) {
      rec = { key, playerId: stat.playerId, clubId: stat.clubId, name: stat.name, cleanSheets: 0, saves: 0 };
      keeperStats.push(rec);
    }
    rec.cleanSheets += stat.cleanSheets;
    rec.saves += stat.saves;
  });
  keeperStats.sort((a, b) => {
    if (b.cleanSheets === a.cleanSheets) return b.saves - a.saves;
    return b.cleanSheets - a.cleanSheets;
  });
  const top = keeperStats.slice(0, 5);
  if (!top.length) return null;
  const mediaUrl = await renderImage({
    title: 'Defensive Walls',
    subtitle: 'Clean sheets (last 2 weeks)',
    labels: top.map(s => s.name),
    values: top.map(s => s.cleanSheets),
    accentColor: '#10b981',
    background: ['#001219', '#002333', '#013a63']
  });
  const lines = top.map((s, idx) => `${idx + 1}. ${s.name} — ${s.cleanSheets} clean sheets, ${s.saves} saves`);
  return {
    type: 'auto',
    title: 'Goalkeeper Spotlight',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'clean_sheet_leaders',
      badge: 'Clean Sheets',
      lines
    }
  };
}

function pickMatch(ctx, filterFn, sortFn) {
  const filtered = ctx.matches.filter(filterFn);
  if (!filtered.length) return null;
  const sorted = sortFn ? filtered.sort(sortFn) : filtered;
  return sorted[0];
}

async function buildMatchOfTheDay(ctx) {
  const interesting = ctx.matches.filter(match => {
    const margin = Math.abs(match.home.goals - match.away.goals);
    const total = match.home.goals + match.away.goals;
    return total >= 4 || margin === 1;
  });
  if (!interesting.length) return null;
  const match = pick(interesting, interesting[0]);
  const title = 'Match of the Day';
  const lines = [
    `${clubName(ctx, match.home.clubId)} ${match.home.goals} - ${match.away.goals} ${clubName(ctx, match.away.clubId)}`,
    `Final • ${fmtRelative(match.ts, ctx.nowMs)}`
  ];
  const mediaUrl = await renderCard({
    title,
    subtitle: 'Drama + fireworks',
    lines,
    accentColor: '#f97316',
    background: ['#020617', '#1e293b', '#111827'],
    footer: 'UPCL Instant Classic'
  });
  return {
    type: 'auto',
    title,
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'match_of_the_day',
      badge: 'Match Recap',
      matchId: match.matchId
    }
  };
}

async function buildBiggestWin(ctx) {
  const match = pickMatch(ctx, () => true, (a, b) => {
    const marginA = Math.abs(a.home.goals - a.away.goals);
    const marginB = Math.abs(b.home.goals - b.away.goals);
    if (marginB === marginA) {
      return (b.home.goals + b.away.goals) - (a.home.goals + a.away.goals);
    }
    return marginB - marginA;
  });
  if (!match || match.home.goals === match.away.goals) return null;
  const winner = match.winner;
  const loser = match.loser;
  if (!winner || !loser) return null;
  const margin = Math.abs(match.home.goals - match.away.goals);
  const title = 'Statement Win';
  const lines = [
    `${clubName(ctx, winner)} routed ${clubName(ctx, loser)}`,
    `Margin: ${margin} (${match.winnerGoals}-${match.loserGoals})`,
    fmtRelative(match.ts, ctx.nowMs)
  ];
  const mediaUrl = await renderCard({
    title,
    subtitle: 'Biggest win of the window',
    lines,
    accentColor: '#ef4444',
    background: ['#200f0f', '#3f0d12', '#111827']
  });
  return {
    type: 'auto',
    title,
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'biggest_win',
      badge: 'Blowout Alert',
      matchId: match.matchId
    }
  };
}

async function buildGoalFest(ctx) {
  const match = pickMatch(ctx, () => true, (a, b) => {
    const totalA = a.home.goals + a.away.goals;
    const totalB = b.home.goals + b.away.goals;
    if (totalB === totalA) return b.ts - a.ts;
    return totalB - totalA;
  });
  if (!match || match.home.goals + match.away.goals < 5) return null;
  const title = 'Goal Frenzy';
  const lines = [
    `${clubName(ctx, match.home.clubId)} ${match.home.goals} - ${match.away.goals} ${clubName(ctx, match.away.clubId)}`,
    `${match.home.goals + match.away.goals} total goals`,
    fmtRelative(match.ts, ctx.nowMs)
  ];
  const mediaUrl = await renderCard({
    title,
    subtitle: 'Highest scoring match',
    lines,
    accentColor: '#facc15',
    background: ['#0f172a', '#1d293a', '#7c2d12']
  });
  return {
    type: 'auto',
    title,
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'goal_frenzy',
      badge: 'Goal Fest',
      matchId: match.matchId
    }
  };
}

async function buildUpset(ctx) {
  const candidates = ctx.matches.filter(match => match.winner && match.loser);
  const upsets = candidates
    .map(match => {
      const winnerRank = ctx.rankMap.get(match.winner) || 999;
      const loserRank = ctx.rankMap.get(match.loser) || 999;
      return {
        match,
        delta: loserRank - winnerRank
      };
    })
    .filter(rec => rec.delta >= 5);
  if (!upsets.length) return null;
  upsets.sort((a, b) => b.delta - a.delta);
  const chosen = upsets[0];
  const { match } = chosen;
  const title = 'Upset Alert';
  const lines = [
    `${clubName(ctx, match.winner)} shocked ${clubName(ctx, match.loser)}`,
    `Rank gap: ${chosen.delta}`,
    fmtRelative(match.ts, ctx.nowMs)
  ];
  const mediaUrl = await renderCard({
    title,
    subtitle: 'Rank-busting win',
    lines,
    accentColor: '#38bdf8',
    background: ['#001f3f', '#0f172a', '#1e293b']
  });
  return {
    type: 'auto',
    title,
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'upset_alert',
      badge: 'Upset Alert',
      matchId: match.matchId
    }
  };
}

function findPlayerMilestones(ctx) {
  const milestones = [];
  ctx.playerTotals.forEach(player => {
    if (!player.goals && !player.assists) return;
    const thresholds = [5, 10, 15, 20, 30, 40, 50];
    const reachedGoal = thresholds.find(th => player.goals === th);
    const reachedAssist = thresholds.find(th => player.assists === th);
    if (reachedGoal) {
      milestones.push({
        type: 'goals',
        value: reachedGoal,
        player
      });
    }
    if (reachedAssist) {
      milestones.push({
        type: 'assists',
        value: reachedAssist,
        player
      });
    }
  });
  milestones.sort((a, b) => {
    const tA = new Date(a.player.lastSeen || 0).getTime();
    const tB = new Date(b.player.lastSeen || 0).getTime();
    return tB - tA;
  });
  return milestones.slice(0, 3);
}

async function buildPlayerMilestone(ctx) {
  const milestones = findPlayerMilestones(ctx);
  if (!milestones.length) return null;
  const lines = milestones.map(m => `${m.player.name} hit ${m.value} ${m.type} for ${clubName(ctx, m.player.clubId)}`);
  const mediaUrl = await renderCard({
    title: 'Milestone Watch',
    subtitle: 'Players hitting landmarks',
    lines,
    accentColor: '#a855f7',
    background: ['#1b1037', '#111827', '#312e81']
  });
  return {
    type: 'auto',
    title: 'Milestone Watch',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'player_milestone',
      badge: 'Milestone',
      lines
    }
  };
}

function computeStreaks(ctx) {
  const hot = [];
  const cold = [];
  ctx.statsByPlayer.forEach(stats => {
    const ordered = stats.slice().sort((a, b) => b.ts - a.ts).slice(0, 6);
    if (!ordered.length) return;
    let consecutiveGoals = 0;
    let consecutiveBlanks = 0;
    for (const stat of ordered) {
      if (stat.goals > 0) {
        consecutiveGoals++;
        consecutiveBlanks = 0;
      } else {
        consecutiveBlanks++;
        consecutiveGoals = 0;
      }
      if (consecutiveGoals >= 3) {
        hot.push({
          playerId: stat.playerId,
          clubId: stat.clubId,
          name: stat.name,
          goals: stat.goals,
          streak: consecutiveGoals,
          lastMatch: stat.ts
        });
        break;
      }
      if (consecutiveBlanks >= 5) {
        cold.push({
          playerId: stat.playerId,
          clubId: stat.clubId,
          name: stat.name,
          streak: consecutiveBlanks,
          lastMatch: stat.ts
        });
        break;
      }
    }
  });
  hot.sort((a, b) => b.streak - a.streak);
  cold.sort((a, b) => b.streak - a.streak);
  return { hot: hot.slice(0, 3), cold: cold.slice(0, 3) };
}

async function buildHotStreak(ctx) {
  const { hot } = computeStreaks(ctx);
  if (!hot.length) return null;
  const lines = hot.map(item => `${item.name} (${clubName(ctx, item.clubId)}) — ${item.streak} straight matches with a goal`);
  const mediaUrl = await renderCard({
    title: 'Heat Check',
    subtitle: 'Scoring streaks',
    lines,
    accentColor: '#fb7185',
    background: ['#2d0a14', '#7f1d1d', '#111827']
  });
  return {
    type: 'auto',
    title: 'Heat Check',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'hot_streak',
      badge: 'Hot Streak',
      lines
    }
  };
}

async function buildColdStreak(ctx) {
  const { cold } = computeStreaks(ctx);
  if (!cold.length) return null;
  const lines = cold.map(item => `${item.name} (${clubName(ctx, item.clubId)}) — ${item.streak} without a goal`);
  const mediaUrl = await renderCard({
    title: 'Ice Cold',
    subtitle: 'Strikers needing a spark',
    lines,
    accentColor: '#60a5fa',
    background: ['#0f172a', '#1e3a8a', '#172554']
  });
  return {
    type: 'auto',
    title: 'Ice Cold Watch',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'cold_streak',
      badge: 'Cold Streak',
      lines
    }
  };
}

function computeClubForm(ctx) {
  const form = [];
  ctx.matchesByClub.forEach((matches, clubId) => {
    const ordered = matches.slice().sort((a, b) => b.ts - a.ts).slice(0, FORM_LOOKBACK_MATCHES);
    if (!ordered.length) return;
    let points = 0;
    const timeline = ordered.map(match => {
      let result = 'D';
      if (match.goalsFor > match.goalsAgainst) {
        points += 3;
        result = 'W';
      } else if (match.goalsFor < match.goalsAgainst) {
        result = 'L';
      } else {
        points += 1;
      }
      return result;
    });
    form.push({
      clubId,
      points,
      timeline
    });
  });
  form.sort((a, b) => b.points - a.points);
  return form;
}

async function buildTeamFormWatch(ctx) {
  const form = computeClubForm(ctx);
  if (!form.length) return null;
  const leader = form[0];
  const title = 'Form Watch';
  const lines = [
    `${clubName(ctx, leader.clubId)} collected ${leader.points} pts over last ${leader.timeline.length}`,
    `Run: ${leader.timeline.join(' • ')}`
  ];
  const values = leader.timeline.map(result => (result === 'W' ? 3 : result === 'D' ? 1 : 0));
  const labels = leader.timeline.map((_, idx) => `M${leader.timeline.length - idx}`);
  const mediaUrl = await renderImage({
    title,
    subtitle: clubName(ctx, leader.clubId),
    labels,
    values,
    type: 'line',
    accentColor: '#22d3ee',
    background: ['#020617', '#0f172a', '#134e4a'],
    extraLines: lines
  });
  return {
    type: 'auto',
    title,
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'form_watch',
      badge: 'Form Tracker',
      clubId: leader.clubId
    }
  };
}

async function buildDivisionGoals(ctx) {
  const byDivision = new Map();
  ctx.matches.forEach(match => {
    const homeDiv = match.division.home || 'Unknown';
    const awayDiv = match.division.away || 'Unknown';
    byDivision.set(homeDiv, (byDivision.get(homeDiv) || 0) + match.home.goals);
    byDivision.set(awayDiv, (byDivision.get(awayDiv) || 0) + match.away.goals);
  });
  const entries = Array.from(byDivision.entries()).filter(([div]) => div && div !== 'Unknown');
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const topEntries = entries.slice(0, 5);
  const mediaUrl = await renderImage({
    title: 'Division Goal Race',
    subtitle: 'Goals scored (last 48h)',
    labels: topEntries.map(([div]) => div),
    values: topEntries.map(([, value]) => value),
    accentColor: '#f59e0b',
    background: ['#331c09', '#7c2d12', '#111827']
  });
  const lines = topEntries.map(([div, value], idx) => `${idx + 1}. ${div} — ${value} goals`);
  return {
    type: 'auto',
    title: 'Division Scoring Race',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'division_goals',
      badge: 'Division Spotlight',
      lines
    }
  };
}

async function buildTeamOfDay(ctx) {
  const roles = {
    GK: [],
    DEF: [],
    MID: [],
    FWD: []
  };
  ctx.playerStats.forEach(stat => {
    const pos = stat.position || '';
    let bucket = 'MID';
    if (/GK/.test(pos)) bucket = 'GK';
    else if (/CB|LB|RB|DEF/.test(pos)) bucket = 'DEF';
    else if (/ST|CF|WF|FW/.test(pos)) bucket = 'FWD';
    roles[bucket].push(stat);
  });
  const pickTop = (arr, count) => arr.slice().sort((a, b) => b.rating - a.rating).slice(0, count);
  const squad = [
    ...pickTop(roles.GK, 1),
    ...pickTop(roles.DEF, 4),
    ...pickTop(roles.MID, 3),
    ...pickTop(roles.FWD, 3)
  ];
  if (!squad.length) return null;
  const lines = squad.map(stat => `${stat.position || 'PLY'} ${stat.name} — Rating ${stat.rating.toFixed(1)} (${clubName(ctx, stat.clubId)})`);
  const mediaUrl = await renderCard({
    title: 'Team of the Day',
    subtitle: 'Best XI (ratings)',
    lines,
    accentColor: '#34d399',
    background: ['#022c22', '#0f172a', '#064e3b']
  });
  return {
    type: 'auto',
    title: 'Team of the Day',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'team_of_day',
      badge: 'Best XI',
      lines
    }
  };
}

async function buildPlayerOfDay(ctx) {
  const standout = ctx.playerStats.filter(stat => stat.rating >= 7).sort((a, b) => {
    if (b.rating === a.rating) return b.goals + b.assists - (a.goals + a.assists);
    return b.rating - a.rating;
  })[0];
  if (!standout) return null;
  const lines = [
    `${standout.name} (${clubName(ctx, standout.clubId)})`,
    `Rating ${standout.rating.toFixed(1)} • ${standout.goals}G ${standout.assists}A`
  ];
  const mediaUrl = await renderCard({
    title: 'Player of the Day',
    subtitle: 'Highest match rating',
    lines,
    accentColor: '#f472b6',
    background: ['#2b0b25', '#581c87', '#111827']
  });
  return {
    type: 'auto',
    title: 'Player of the Day',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'player_of_day',
      badge: 'Star Performer',
      playerId: standout.playerId,
      clubId: standout.clubId
    }
  };
}

async function buildSurpriseStat(ctx) {
  const defenders = ctx.playerStats.filter(stat => /CB|LB|RB|DEF/.test(stat.position) && stat.assists > 0);
  if (!defenders.length) return null;
  defenders.sort((a, b) => b.assists - a.assists);
  const top = defenders.slice(0, 3);
  const lines = top.map(stat => `${stat.name} (${stat.position}) — ${stat.assists} assists for ${clubName(ctx, stat.clubId)}`);
  const mediaUrl = await renderCard({
    title: 'Surprise Stat',
    subtitle: 'Defensive playmakers',
    lines,
    accentColor: '#facc15',
    background: ['#1f2937', '#111827', '#831843']
  });
  return {
    type: 'auto',
    title: 'Surprise Stat',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'surprise_stat',
      badge: 'Did You Know',
      lines
    }
  };
}

async function buildPowerRankings(ctx) {
  const form = computeClubForm(ctx).slice(0, 6);
  if (!form.length) return null;
  const labels = form.map(entry => clubName(ctx, entry.clubId));
  const values = form.map(entry => entry.points);
  const lines = form.map((entry, idx) => `${idx + 1}. ${clubName(ctx, entry.clubId)} — ${entry.points} pts (${entry.timeline.join(' ')})`);
  const mediaUrl = await renderImage({
    title: 'Power Rankings',
    subtitle: 'Recent form points',
    labels,
    values,
    accentColor: '#22c55e',
    background: ['#01110b', '#0f172a', '#14532d'],
    extraLines: [lines[0], lines[1] || '']
  });
  return {
    type: 'auto',
    title: 'Power Rankings',
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'power_rankings',
      badge: 'Power Rankings',
      lines
    }
  };
}

async function buildNewsPoll(ctx) {
  const topScorers = ctx.leaders.filter(l => l.type === 'scorer').slice(0, 4);
  const options = topScorers.length
    ? topScorers.map(s => s.name)
    : ctx.standings.slice(0, 4).map(row => clubName(ctx, row.clubId));
  if (!options.length) return null;
  const question = topScorers.length
    ? 'Who will win the Golden Boot?'
    : 'Who tops the table next week?';
  const lines = options.map((option, idx) => `${String.fromCharCode(65 + idx)}. ${option}`);
  const mediaUrl = await renderCard({
    title: 'Fan Poll',
    subtitle: question,
    lines,
    accentColor: '#38bdf8',
    background: ['#020617', '#0f172a', '#312e81']
  });
  return {
    type: 'auto',
    title: question,
    body: lines.join('\n'),
    mediaUrl,
    payload: {
      kind: 'news_poll',
      badge: 'Fan Vote',
      options
    }
  };
}

async function buildBanterFact(ctx) {
  if (!ctx.matches.length) return null;
  const mostGoals = ctx.matches.reduce((best, match) => {
    const goals = match.home.goals + match.away.goals;
    if (!best || goals > best.goals) {
      return { club: match.home.clubId, goals };
    }
    return best;
  }, null);
  if (!mostGoals) return null;
  const randomClub = pick(ctx.standings, ctx.standings[0]);
  if (!randomClub) return null;
  const line = `${clubName(ctx, mostGoals.club)} scored in one night what ${clubName(ctx, randomClub.clubId)} managed in ${randomClub.pts ? `${Math.ceil(randomClub.pts / 3)} games` : 'a week'}`;
  const mediaUrl = await renderCard({
    title: 'Banter Report',
    subtitle: 'Fun fact generator',
    lines: [line],
    accentColor: '#f97316',
    background: ['#160705', '#7c2d12', '#0f172a']
  });
  return {
    type: 'auto',
    title: 'Banter Corner',
    body: line,
    mediaUrl,
    payload: {
      kind: 'banter_fact',
      badge: 'Fun Fact'
    }
  };
}

const BUILDERS = [
  buildStandingsSnapshot,
  buildGoalLeaders,
  buildAssistLeaders,
  buildCleanSheetLeaders,
  buildMatchOfTheDay,
  buildBiggestWin,
  buildGoalFest,
  buildUpset,
  buildPlayerMilestone,
  buildHotStreak,
  buildColdStreak,
  buildTeamFormWatch,
  buildDivisionGoals,
  buildTeamOfDay,
  buildPlayerOfDay,
  buildSurpriseStat,
  buildPowerRankings,
  buildNewsPoll,
  buildBanterFact
];

async function generateAutoNews(nowMs = Date.now()) {
  const ctx = await fetchContext(nowMs);
  const builders = shuffle(BUILDERS);
  const items = [];
  const usedKinds = new Set();
  for (const builder of builders) {
    if (items.length >= AUTO_BATCH_TARGET) break;
    try {
      const item = await builder(ctx);
      if (!item) continue;
      const kind = item.payload?.kind;
      if (kind && usedKinds.has(kind)) continue;
      usedKinds.add(kind);
      item.expiresAt = new Date(nowMs + AUTO_EXPIRY_MS).toISOString();
      if (!item.payload) item.payload = {};
      item.payload.generatedAt = new Date(nowMs).toISOString();
      if (typeof item.payload.badge !== 'string') {
        item.payload.badge = 'Auto Update';
      }
      if (item.payload && item.payload.kind && !item.payload.slug) {
        const baseKind = item.payload.kind === 'standings_snapshot'
          ? 'standings'
          : item.payload.kind;
        const slug = `auto-${baseKind.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
        item.payload.slug = slug;
      }
      items.push(item);
    } catch (err) {
      logger.warn({ err }, 'Auto news builder failed');
    }
  }
  return items;
}

async function runAutoNews() {
  const nowMs = Date.now();
  await newsRepo.pruneExpired().catch(err => logger.warn({ err }, 'Failed pruning expired news'));
  const autoNews = await generateAutoNews(nowMs);
  if (!autoNews.length) return [];
  const kinds = autoNews.map(item => item.payload?.kind).filter(Boolean);
  if (kinds.length) {
    await newsRepo.deleteByKinds(kinds).catch(err => logger.warn({ err }, 'Failed deleting old auto news'));
  }
  const inserted = await newsRepo.insertMany(autoNews.map(item => ({
    ...item,
    author: 'Auto Desk'
  })));
  return inserted;
}

module.exports = {
  generateAutoNews,
  runAutoNews
};
