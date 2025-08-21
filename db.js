// db.js
const { Pool } = require('pg');

// Use internal connection string (no SSL required inside Render)
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://upcl_user:2wMTWrulMhUoAYk5Z9lUpgaYYZobJYGf@dpg-d2hslce3jp1c738nvgg0-a/upcl",
});

function ensureTable(sql, name) {
  return pool
    .query(sql)
    .then(() => console.log(`Ensured ${name} table`))
    .catch(err => {
      console.error(`Failed to ensure ${name} table`, err);
    });
}

// Ensure fixtures table exists
ensureTable(
  `
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
`,
  'fixtures'
);

// Store league metadata (teams, etc.)
ensureTable(
  `
  CREATE TABLE IF NOT EXISTS leagues (
    id TEXT PRIMARY KEY,
    details JSONB
  )
`,
  'leagues'
);

// Track last fetched EA match per club
ensureTable(
  `
  CREATE TABLE IF NOT EXISTS ea_last_matches (
    club_id TEXT PRIMARY KEY,
    last_match_id TEXT
  )
`,
  'ea_last_matches'
);

// Recent match history fetched from EA API
ensureTable(
  `
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    matchDate TIMESTAMPTZ,
    clubIds JSONB,
    raw JSONB
  )
`,
  'matches'
);

// Cached teams and players from EA API
ensureTable(
  `
  CREATE TABLE IF NOT EXISTS teams (
    id BIGINT PRIMARY KEY,
    name TEXT,
    logo JSONB,
    season JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )
`,
  'teams'
);

ensureTable(
  `
  CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    club_id BIGINT REFERENCES teams(id),
    name TEXT,
    position TEXT,
    stats JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )
`,
  'players'
);

module.exports = pool;
