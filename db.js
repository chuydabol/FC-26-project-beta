let pool;
let tableReadyPromise;

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
  getApprovedLeagueMatches,
  getPendingMatches,
  getSavedMatches,
  insertMatch,
  normalizeMatchDate,
  rejectMatch,
};
