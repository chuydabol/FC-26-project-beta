const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://upcl_user:2wMTWrulMhUoAYk5Z9lUpgaYYZobJYGf@dpg-d2hslce3jp1c738nvgg0-a:5432/upcl?sslmode=require",
  ssl: {
    rejectUnauthorized: false,
  },
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

// Store league metadata (teams, etc.)
pool.query(`
  CREATE TABLE IF NOT EXISTS leagues (
    id TEXT PRIMARY KEY,
    details JSONB
  )
`).catch(err => {
  console.error('Failed to ensure leagues table', err);
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

// Recent match history fetched from EA API
pool.query(`
  CREATE TABLE IF NOT EXISTS matches (
    id BIGINT PRIMARY KEY,
    timestamp TIMESTAMPTZ,
    clubs JSONB,
    players JSONB,
    raw JSONB
  )
`).catch(err => {
  console.error('Failed to ensure matches table', err);
});

// Cached teams and players from EA API
pool.query(`
  CREATE TABLE IF NOT EXISTS teams (
    id BIGINT PRIMARY KEY,
    name TEXT,
    logo JSONB,
    season JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )
`).catch(err => {
  console.error('Failed to ensure teams table', err);
});

pool.query(`
  CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    club_id BIGINT REFERENCES teams(id),
    name TEXT,
    position TEXT,
    stats JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )
`).catch(err => {
  console.error('Failed to ensure players table', err);
});

module.exports = pool;
