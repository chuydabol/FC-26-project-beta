const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function runSql(sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);              // SQL files contain NO BEGIN/COMMIT
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexical order

  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Safety: warn if a file still has BEGIN/COMMIT
    if (/^\s*BEGIN\b/i.test(sql) || /^\s*COMMIT\b/i.test(sql)) {
      console.warn(`[migrate] WARNING: ${f} contains BEGIN/COMMIT; remove them.`);
    }
    console.log('[migrate] applying', f);
    await runSql(sql);
  }
}

module.exports = { runMigrations };
