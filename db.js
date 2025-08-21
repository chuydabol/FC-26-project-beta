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

async function initDb() {
  // Ensure fixtures table exists
  await ensureTable(
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
  await ensureTable(
    `
    CREATE TABLE IF NOT EXISTS leagues (
      id TEXT PRIMARY KEY,
      details JSONB
    )
  `,
    'leagues'
  );

  // Track last fetched EA match per club
  await ensureTable(
    `
    CREATE TABLE IF NOT EXISTS ea_last_matches (
      club_id TEXT PRIMARY KEY,
      last_match_id TEXT
    )
  `,
    'ea_last_matches'
  );

  // Clubs catalog
  await ensureTable(
    `
    CREATE TABLE IF NOT EXISTS clubs (
      club_id   TEXT PRIMARY KEY,
      club_name TEXT NOT NULL
    )
  `,
    'clubs'
  );

  // Matches: one row per match
  await ensureTable(
    `
    CREATE TABLE IF NOT EXISTS matches (
      match_id  TEXT  PRIMARY KEY,
      ts_ms     BIGINT NOT NULL,
      raw       JSONB  NOT NULL
    )
  `,
    'matches'
  );

  // Participants: two rows per match (home/away)
  await ensureTable(
    `
    CREATE TABLE IF NOT EXISTS match_participants (
      match_id  TEXT   NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
      club_id   TEXT   NOT NULL REFERENCES clubs(club_id),
      is_home   BOOLEAN NOT NULL,
      goals     INT     NOT NULL DEFAULT 0,
      PRIMARY KEY (match_id, club_id)
    )
  `,
    'match_participants'
  );

  // Indexes
  await ensureTable(
    `CREATE INDEX IF NOT EXISTS idx_matches_ts_ms_desc ON matches (ts_ms DESC)`,
    'idx_matches_ts_ms_desc'
  );
  await ensureTable(
    `CREATE INDEX IF NOT EXISTS idx_mp_club_ts ON match_participants (club_id, match_id)`,
    'idx_mp_club_ts'
  );

  // Cached teams and players from EA API
  await ensureTable(
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

  await ensureTable(
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
}

module.exports = pool;
module.exports.initDb = initDb;
