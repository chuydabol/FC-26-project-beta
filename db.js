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
    tableReadyPromise = query(`
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
    `).catch(error => {
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
      raw_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    SELECT
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
      created_at
    FROM matches
    ORDER BY match_date DESC NULLS LAST, id DESC
  `);
  return response.rows;
}

module.exports = {
  ensureMatchesTable,
  getSavedMatches,
  insertMatch,
  normalizeMatchDate,
};
