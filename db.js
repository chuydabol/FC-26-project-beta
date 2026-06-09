let pool;
let tableReadyPromise;
let playerStatsReadyPromise;

function getDatabaseUrl() {
  return process.env.DATABASE_URL;
}

function createPool() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for Postgres access');
  }

  // Load pg lazily so routes that do not use the database can still run in
  // environments where dependencies have not been installed yet.
  const { Pool } = require('pg');
  const isLocalDatabase = /^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(databaseUrl);

  return new Pool({
    connectionString: databaseUrl,
    ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  });
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

async function query(sql, params) {
  return getPool().query(sql, params);
}

async function ensureMatchesTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS matches (
          id serial PRIMARY KEY,
          match_id text UNIQUE NOT NULL,
          source_club_id text NOT NULL,
          club_name text,
          opponent_name text,
          club_score integer,
          opponent_score integer,
          result text,
          match_date timestamp,
          raw_json jsonb,
          created_at timestamp DEFAULT now()
        )
      `);

      await query(`
        ALTER TABLE matches
          ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS competition text DEFAULT 'friendly',
          ADD COLUMN IF NOT EXISTS matchday integer,
          ADD COLUMN IF NOT EXISTS series_id text,
          ADD COLUMN IF NOT EXISTS notes text
      `);

      await query(`
        UPDATE matches
        SET
          status = COALESCE(status, 'pending'),
          competition = COALESCE(competition, 'friendly')
        WHERE status IS NULL OR competition IS NULL
      `);
    })().catch(error => {
      tableReadyPromise = null;
      throw error;
    });
  }

  return tableReadyPromise;
}

async function ensurePlayerStatsTables() {
  if (!playerStatsReadyPromise) {
    playerStatsReadyPromise = (async () => {
      await ensureMatchesTable();

      await query(`
        CREATE TABLE IF NOT EXISTS players (
          id serial PRIMARY KEY,
          ea_player_id text UNIQUE,
          player_name text NOT NULL,
          club_id text,
          club_name text,
          position text,
          avatar_url text,
          active boolean DEFAULT true,
          created_at timestamp DEFAULT now()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS player_match_stats (
          id serial PRIMARY KEY,
          match_id text NOT NULL,
          ea_player_id text,
          player_name text NOT NULL,
          club_id text,
          club_name text,
          goals integer DEFAULT 0,
          assists integer DEFAULT 0,
          passes_attempted integer DEFAULT 0,
          passes_made integer DEFAULT 0,
          tackles_attempted integer DEFAULT 0,
          tackles_made integer DEFAULT 0,
          man_of_the_match boolean DEFAULT false,
          raw_json jsonb,
          created_at timestamp DEFAULT now(),
          UNIQUE(match_id, ea_player_id)
        )
      `);
    })().catch(error => {
      playerStatsReadyPromise = null;
      throw error;
    });
  }

  return playerStatsReadyPromise;
}

async function getPlayerStats() {
  await ensurePlayerStatsTables();
  const response = await query(`
    SELECT
      pms.player_name,
      COALESCE(MAX(NULLIF(pms.club_name, '')), '') AS club_name,
      COUNT(DISTINCT pms.match_id)::integer AS matches_played,
      COALESCE(SUM(pms.goals), 0)::integer AS goals,
      COALESCE(SUM(pms.assists), 0)::integer AS assists,
      COALESCE(SUM(pms.passes_attempted), 0)::integer AS passes_attempted,
      COALESCE(SUM(pms.passes_made), 0)::integer AS passes_made,
      CASE
        WHEN COALESCE(SUM(pms.passes_attempted), 0) = 0 THEN 0
        ELSE ROUND((SUM(pms.passes_made)::numeric / NULLIF(SUM(pms.passes_attempted), 0)) * 100, 1)
      END::float AS pass_percentage,
      COALESCE(SUM(pms.tackles_attempted), 0)::integer AS tackles_attempted,
      COALESCE(SUM(pms.tackles_made), 0)::integer AS tackles_made,
      CASE
        WHEN COALESCE(SUM(pms.tackles_attempted), 0) = 0 THEN 0
        ELSE ROUND((SUM(pms.tackles_made)::numeric / NULLIF(SUM(pms.tackles_attempted), 0)) * 100, 1)
      END::float AS tackle_percentage,
      COALESCE(SUM(CASE WHEN pms.man_of_the_match THEN 1 ELSE 0 END), 0)::integer AS motm_count
    FROM player_match_stats pms
    INNER JOIN matches m ON m.match_id = pms.match_id
    WHERE m.status = 'approved'
      AND m.competition = 'league'
    GROUP BY COALESCE(pms.ea_player_id, pms.player_name), pms.player_name
    ORDER BY goals DESC, assists DESC, motm_count DESC, pms.player_name ASC
  `);
  return response.rows;
}


function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(normalized);
}

function getPlayerName(player) {
  return firstDefined(player.playername);
}

function normalizePlayerMatchStats(match) {
  const rawMatch = match?.raw || match?.raw_json || match || {};
  const rawPlayers = rawMatch.players;
  if (!rawPlayers || typeof rawPlayers !== 'object' || Array.isArray(rawPlayers)) return [];

  const rows = [];
  for (const [clubId, playersForClub] of Object.entries(rawPlayers)) {
    if (!playersForClub || typeof playersForClub !== 'object') continue;
    const clubName = rawMatch.clubs?.[clubId]?.details?.name;

    for (const [playerId, player] of Object.entries(playersForClub)) {
      if (!player || typeof player !== 'object') continue;
      const playerName = getPlayerName(player);
      if (!playerName) continue;

      rows.push({
        match_id: match.match_id || match.id || rawMatch.matchId || rawMatch.matchid || rawMatch.id,
        ea_player_id: String(playerId),
        player_name: String(playerName),
        club_id: String(clubId),
        club_name: clubName ? String(clubName) : null,
        position: firstDefined(player.pos, null),
        goals: toInteger(player.goals || 0),
        assists: toInteger(player.assists || 0),
        passes_attempted: toInteger(player.passattempts || 0),
        passes_made: toInteger(player.passesmade || 0),
        tackles_attempted: toInteger(player.tackleattempts || 0),
        tackles_made: toInteger(player.tacklesmade || 0),
        man_of_the_match: player.mom === '1',
        raw_json: player,
      });
    }
  }

  return rows.filter(row => row.match_id && row.ea_player_id && row.player_name);
}

async function insertPlayerMatchStats(match, sourceClub) {
  const stats = normalizePlayerMatchStats(match, sourceClub);
  if (!stats.length) return 0;

  await ensurePlayerStatsTables();
  let saved = 0;
  for (const stat of stats) {
    const logContext = {
      matchId: stat.match_id,
      clubId: stat.club_id,
      clubName: stat.club_name,
      playerId: stat.ea_player_id,
      playername: stat.player_name,
    };
    console.log({ ...logContext }, 'Saving player match stats');

    try {
      await query(
        `INSERT INTO players (
          ea_player_id,
          player_name,
          club_id,
          club_name,
          position
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (ea_player_id) DO UPDATE
        SET player_name = EXCLUDED.player_name,
            club_id = EXCLUDED.club_id,
            club_name = EXCLUDED.club_name,
            position = COALESCE(EXCLUDED.position, players.position),
            active = true`,
        [stat.ea_player_id, stat.player_name, stat.club_id, stat.club_name, stat.position]
      );

      const response = await query(
        `INSERT INTO player_match_stats (
          match_id,
          ea_player_id,
          player_name,
          club_id,
          club_name,
          goals,
          assists,
          passes_attempted,
          passes_made,
          tackles_attempted,
          tackles_made,
          man_of_the_match,
          raw_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (match_id, ea_player_id) DO UPDATE
        SET player_name = EXCLUDED.player_name,
            club_id = EXCLUDED.club_id,
            club_name = EXCLUDED.club_name,
            goals = EXCLUDED.goals,
            assists = EXCLUDED.assists,
            passes_attempted = EXCLUDED.passes_attempted,
            passes_made = EXCLUDED.passes_made,
            tackles_attempted = EXCLUDED.tackles_attempted,
            tackles_made = EXCLUDED.tackles_made,
            man_of_the_match = EXCLUDED.man_of_the_match,
            raw_json = EXCLUDED.raw_json`,
        [
          stat.match_id,
          stat.ea_player_id,
          stat.player_name,
          stat.club_id,
          stat.club_name,
          stat.goals,
          stat.assists,
          stat.passes_attempted,
          stat.passes_made,
          stat.tackles_attempted,
          stat.tackles_made,
          stat.man_of_the_match,
          JSON.stringify(stat.raw_json),
        ]
      );
      saved += response.rowCount || 0;
      console.log({ ...logContext }, 'Player match stats insert success');
    } catch (error) {
      console.error({ ...logContext, err: error }, 'Player match stats insert failure');
      throw error;
    }
  }

  return saved;
}

function normalizeMatchDate(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapMatchRowColumns() {
  return `
    id,
    match_id,
    source_club_id,
    club_name,
    opponent_name,
    club_score,
    opponent_score,
    result,
    match_date,
    raw_json,
    created_at,
    status,
    competition,
    matchday,
    series_id,
    notes
  `;
}

async function insertMatch(match, sourceClub) {
  await ensurePlayerStatsTables();
  const response = await query(
    `INSERT INTO matches (
      match_id,
      source_club_id,
      club_name,
      opponent_name,
      club_score,
      opponent_score,
      result,
      match_date,
      raw_json,
      status,
      competition
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'friendly')
    ON CONFLICT (match_id) DO NOTHING
    RETURNING id`,
    [
      match.id,
      sourceClub.id,
      match.team?.name || sourceClub.name || null,
      match.opponent?.name || null,
      match.score?.for ?? null,
      match.score?.against ?? null,
      match.result || null,
      normalizeMatchDate(match.timestamp),
      JSON.stringify(match.raw || match),
    ]
  );

  await insertPlayerMatchStats(match, sourceClub);

  return response.rowCount === 1;
}


async function backfillPlayerStats() {
  await ensurePlayerStatsTables();
  const response = await query(`
    SELECT match_id, source_club_id, club_name, raw_json
    FROM matches
    WHERE raw_json IS NOT NULL
    ORDER BY match_date ASC NULLS LAST, id ASC
  `);

  let processedMatches = 0;
  let savedPlayerStats = 0;
  for (const row of response.rows) {
    const saved = await insertPlayerMatchStats({
      match_id: row.match_id,
      raw_json: row.raw_json,
    });
    processedMatches += 1;
    savedPlayerStats += saved;
  }

  return {
    processedMatches,
    savedPlayerStats,
  };
}

async function getSavedMatches() {
  await ensureMatchesTable();
  const response = await query(`
    SELECT ${mapMatchRowColumns()}
    FROM matches
    ORDER BY match_date DESC NULLS LAST, id DESC
  `);
  return response.rows;
}

async function getApprovedLeagueMatches() {
  await ensureMatchesTable();
  const response = await query(`
    SELECT ${mapMatchRowColumns()}
    FROM matches
    WHERE status = 'approved'
      AND competition = 'league'
    ORDER BY match_date DESC NULLS LAST, id DESC
  `);
  return response.rows;
}

async function getPendingMatches() {
  await ensureMatchesTable();
  const response = await query(`
    SELECT ${mapMatchRowColumns()}
    FROM matches
    WHERE status = 'pending'
    ORDER BY match_date DESC NULLS LAST, id DESC
  `);
  return response.rows;
}

function normalizeMatchday(matchday) {
  if (matchday === null || matchday === undefined || matchday === '') return null;
  const number = Number(matchday);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('matchday must be a positive integer when provided');
  }
  return number;
}

function normalizeCompetition(competition = 'league') {
  const value = String(competition || 'league').trim().toLowerCase();
  if (!['league', 'friendly'].includes(value)) {
    throw new Error('competition must be league or friendly');
  }
  return value;
}

async function approveMatch(matchId, options = {}) {
  await ensureMatchesTable();
  const competition = normalizeCompetition(options.competition);
  const matchday = normalizeMatchday(options.matchday);
  const response = await query(
    `UPDATE matches
     SET status = 'approved',
         competition = $2,
         matchday = $3,
         notes = COALESCE($4, notes)
     WHERE match_id = $1
     RETURNING ${mapMatchRowColumns()}`,
    [matchId, competition, matchday, options.notes ?? null]
  );
  return response.rows[0] || null;
}


async function resetApprovedMatches() {
  await ensureMatchesTable();
  const response = await query(`
    UPDATE matches
    SET status = 'pending',
        competition = 'friendly',
        matchday = NULL,
        series_id = NULL
    WHERE status = 'approved'
  `);
  return response.rowCount || 0;
}

async function rejectMatch(matchId, options = {}) {
  await ensureMatchesTable();
  const response = await query(
    `UPDATE matches
     SET status = 'rejected',
         notes = COALESCE($2, notes)
     WHERE match_id = $1
     RETURNING ${mapMatchRowColumns()}`,
    [matchId, options.notes ?? null]
  );
  return response.rows[0] || null;
}

module.exports = {
  approveMatch,
  backfillPlayerStats,
  ensureMatchesTable,
  ensurePlayerStatsTables,
  getApprovedLeagueMatches,
  getPendingMatches,
  getPlayerStats,
  insertPlayerMatchStats,
  getSavedMatches,
  insertMatch,
  normalizeMatchDate,
  normalizePlayerMatchStats,
  resetApprovedMatches,
  rejectMatch,
};
