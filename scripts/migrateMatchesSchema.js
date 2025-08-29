const { pool } = require('../db');

async function migrate() {
  const migrationSql = `
BEGIN;
CREATE TABLE IF NOT EXISTS clubs (
  club_id   TEXT PRIMARY KEY,
  club_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  match_id  TEXT  PRIMARY KEY,
  ts_ms     BIGINT NOT NULL,
  raw       JSONB  NOT NULL
);
ALTER TABLE matches RENAME COLUMN IF EXISTS id TO match_id;
ALTER TABLE matches DROP COLUMN IF EXISTS club_id;
CREATE TABLE IF NOT EXISTS match_participants (
  match_id  TEXT   NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  club_id   TEXT   NOT NULL REFERENCES clubs(club_id),
  is_home   BOOLEAN NOT NULL,
  goals     INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, club_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_ts_ms_desc ON matches (ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_mp_club_ts ON match_participants (club_id, match_id);
COMMIT;`;

  const seedSql = `
INSERT INTO clubs (club_id, club_name) VALUES
('576007','Ethabella'),
('567756','Potland Pounders'),
('3638105','Real MVC'),
('55408','Elite VT'),
('3465152','Razorblacks FC'),
  ('1969494','Club Frijol'),
  ('2491998','Royal Republic'),
  ('4819681','Everything Dead'),
  ('52008','afc warriors'),
  ('2040883','Iron United'),
  ('3160508','Mad Ladz 117')
  ON CONFLICT (club_id) DO NOTHING;`;

  try {
    await pool.query(migrationSql);
    await pool.query(seedSql);
    console.log('Migration complete');
  } catch (err) {
    console.error('Migration failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
