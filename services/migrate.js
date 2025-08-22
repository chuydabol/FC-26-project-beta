const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function runSql(sql) {
  const client = await pool.connect();
  const hasTx = /\bBEGIN\b/i.test(sql);
  try {
    if (hasTx) {
      await client.query(sql);
    } else {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    }
  } catch (err) {
    if (!hasTx) {
      await client.query('ROLLBACK');
    }
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
    console.log('[migrate] applying', f);
    await runSql(sql);
  }
}

module.exports = { runMigrations };
