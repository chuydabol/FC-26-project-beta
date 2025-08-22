const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function runSqlFile(sqlPath) {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
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
    .sort(); // run in lexical order
  for (const f of files) {
    const p = path.join(dir, f);
    console.log('[migrate] applying', f);
    await runSqlFile(p);
  }
}

module.exports = { runMigrations };
