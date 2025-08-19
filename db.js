const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL env var is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Ensure fixtures table exists
pool.query(`
  CREATE TABLE IF NOT EXISTS fixtures (
    id TEXT PRIMARY KEY,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    score JSONB,
    status TEXT,
    details JSONB,
    league_id TEXT,
    played_at TIMESTAMPTZ
  )
`).catch(err => {
  console.error('Failed to ensure fixtures table', err);
});

// Track last fetched EA match per club
pool.query(`
  CREATE TABLE IF NOT EXISTS ea_last_matches (
    club_id TEXT PRIMARY KEY,
    last_match_id TEXT
  )
`).catch(err => {
  console.error('Failed to ensure ea_last_matches table', err);
});

module.exports = pool;
