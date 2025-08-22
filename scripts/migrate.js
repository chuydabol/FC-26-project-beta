const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function runMigrations() {
  const dir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const filePath = path.join(dir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    if (/\bBEGIN\b/i.test(sql) || /\bCOMMIT\b/i.test(sql)) {
      throw new Error(`BEGIN/COMMIT found in migration ${file}`);
    }
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('COMMIT');
      console.log(`Ran migration ${file}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('Migrations complete');
    })
    .catch(err => {
      console.error('Migration failed', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { runMigrations };
