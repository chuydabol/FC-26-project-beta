const { pool } = require('../db');
const { parseVpro } = require('./playerCards');

async function getPlayerAttributes(playerId, clubId) {
  const m = await pool.query(
    `SELECT m.raw->'players'->$1->$2->>'vproattr' AS vproattr
       FROM public.matches m
       JOIN public.match_participants mp ON mp.match_id = m.match_id
       WHERE mp.club_id = $1
       ORDER BY m.ts_ms DESC
       LIMIT 1`,
    [clubId, playerId]
  );
  if (m.rows[0]?.vproattr) return parseVpro(m.rows[0].vproattr);

  const p = await pool.query(
    `SELECT vproattr FROM public.players WHERE player_id = $1 AND club_id = $2`,
    [playerId, clubId]
  );
  if (p.rows[0]?.vproattr) return parseVpro(p.rows[0].vproattr);

  return null;
}

module.exports = { getPlayerAttributes };
