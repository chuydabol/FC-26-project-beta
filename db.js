// db.js
const { Pool } = require('pg');

// Use internal connection string (no SSL required inside Render)
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://upcl_user:2wMTWrulMhUoAYk5Z9lUpgaYYZobJYGf@dpg-d2hslce3jp1c738nvgg0-a/upcl",
});

module.exports = pool;
