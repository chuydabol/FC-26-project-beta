// db.js
const { Pool } = require('pg');

const connStr = process.env.DATABASE_URL;
let pool;
if (connStr) {
  // Ensure we default to the public schema
  pool = new Pool({ connectionString: connStr });
  pool.on('connect', c => c.query('SET search_path TO public'));
} else {
  // Minimal stub pool for environments without a real database
  pool = { query: async () => { throw new Error('DATABASE_URL not set'); }, on: () => {} };
}

module.exports = { pool };
