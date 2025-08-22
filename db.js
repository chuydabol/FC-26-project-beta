// db.js
const { Pool } = require('pg');

// Use internal connection string (no SSL required inside Render)
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://upcl_user:2wMTWrulMhUoAYk5Z9lUpgaYYZobJYGf@dpg-d2hslce3jp1c738nvgg0-a/upcl",
});

// Ensure we default to the public schema
pool.on('connect', c => c.query('SET search_path TO public'));

async function initDb() {
  if (process.env.DISABLE_INITDB === '1') {
    console.log('[initDb] disabled (using migrations)');
    return;
  }
  // legacy init removed
}

module.exports = { pool, initDb };
