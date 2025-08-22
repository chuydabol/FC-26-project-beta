const { pool } = require('../db');

async function q(text, params) {
  try { return await pool.query(text, params); }
  catch (err) {
    console.error('[PG ERROR]', {
      code: err.code, position: err.position, text, params
    });
    throw err;
  }
}
module.exports = { q };
