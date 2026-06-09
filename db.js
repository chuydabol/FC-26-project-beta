let pool;
let tableReadyPromise;
let playerStatsTableReadyPromise;

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
  await ensureMatchesTable();
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

  return response.rowCount === 1;
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

async function ensurePlayerStatsTable() {
  if (!playerStatsTableReadyPromise) {
    playerStatsTableReadyPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS player_stats (
          id serial PRIMARY KEY,
          player_name text NOT NULL,
          club_name text,
          goals integer NOT NULL DEFAULT 0,
          assists integer NOT NULL DEFAULT 0,
          created_at timestamp DEFAULT now(),
          updated_at timestamp DEFAULT now()
        )
      `);

      await query(`
        ALTER TABLE player_stats
          ADD COLUMN IF NOT EXISTS club_name text,
          ADD COLUMN IF NOT EXISTS goals integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS assists integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now()
      `);
    })().catch(error => {
      playerStatsTableReadyPromise = null;
      throw error;
    });
  }

  return playerStatsTableReadyPromise;
}

function normalizePlayerStatText(value, fieldName, required = false) {
  const text = String(value || '').trim();
  if (required && !text) throw new Error(`${fieldName} is required`);
  return text || null;
}

function normalizePlayerStatNumber(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return number;
}

function mapPlayerStatRowColumns() {
  return `
    id,
    player_name,
    club_name,
    goals,
    assists,
    created_at,
    updated_at
  `;
}

async function getPlayerStats() {
  await ensurePlayerStatsTable();
  const response = await query(`
    SELECT ${mapPlayerStatRowColumns()}
    FROM player_stats
    ORDER BY goals DESC, assists DESC, player_name ASC, id ASC
  `);
  return response.rows;
}

async function savePlayerStat(stat) {
  await ensurePlayerStatsTable();
  const playerName = normalizePlayerStatText(stat.playerName ?? stat.player_name, 'playerName', true);
  const clubName = normalizePlayerStatText(stat.clubName ?? stat.club_name, 'clubName');
  const goals = normalizePlayerStatNumber(stat.goals, 'goals');
  const assists = normalizePlayerStatNumber(stat.assists, 'assists');

  const response = await query(
    `INSERT INTO player_stats (player_name, club_name, goals, assists, updated_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING ${mapPlayerStatRowColumns()}`,
    [playerName, clubName, goals, assists]
  );

  return response.rows[0];
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
  ensureMatchesTable,
  ensurePlayerStatsTable,
  getApprovedLeagueMatches,
  getPendingMatches,
  getPlayerStats,
  getSavedMatches,
  insertMatch,
  savePlayerStat,
  normalizeMatchDate,
  rejectMatch,
};
