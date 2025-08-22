// db.js
const { Pool } = require('pg');

const connStr = process.env.DATABASE_URL;
if (!connStr) {
  throw new Error('DATABASE_URL not set');
}

// Ensure we default to the public schema
const pool = new Pool({ connectionString: connStr });
pool.on('connect', c => c.query('SET search_path TO public'));

module.exports = { pool };
