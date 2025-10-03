const { pool } = require('../db');
const { parseVpro } = require('./playerCards');
const { toBigIntParam } = require('./pgwrap');

async function getPlayerAttributes(playerId, clubId) {
  let useNumeric = true;
  let clubIdParam;
  let playerIdParam;
  try {
    clubIdParam = toBigIntParam(clubId);
    playerIdParam = toBigIntParam(playerId);
  } catch (err) {
    if (err instanceof TypeError) {
      useNumeric = false;
    } else {
      throw err;
    }
  }
  if (clubIdParam === null || playerIdParam === null) {
    useNumeric = false;
  }

  const clubKey = String(useNumeric ? clubIdParam : clubId ?? '');
  const playerKey = String(useNumeric ? playerIdParam : playerId ?? '');
  const matchParam = useNumeric ? clubIdParam : String(clubId ?? '');
  const matchWhere = useNumeric
    ? 'WHERE mp.club_id::bigint = $3::bigint'
    : 'WHERE mp.club_id::text = $3::text';

  const m = await pool.query(
    `SELECT m.raw->'players'->$1->$2->>'vproattr' AS vproattr
       FROM public.matches m
       JOIN public.match_participants mp ON mp.match_id = m.match_id
       ${matchWhere}
       ORDER BY m.ts_ms DESC
       LIMIT 1`,
    [clubKey, playerKey, matchParam]
  );
  if (m.rows[0]?.vproattr) return parseVpro(m.rows[0].vproattr);

  const playerWhere = useNumeric
    ? 'WHERE player_id::bigint = $1::bigint AND club_id::bigint = $2::bigint'
    : 'WHERE player_id::text = $1::text AND club_id::text = $2::text';
  const playerParams = useNumeric
    ? [playerIdParam, clubIdParam]
    : [String(playerId ?? ''), String(clubId ?? '')];

  const p = await pool.query(
    `SELECT vproattr FROM public.players ${playerWhere}`,
    playerParams
  );
  if (p.rows[0]?.vproattr) return parseVpro(p.rows[0].vproattr);

  return null;
}

module.exports = { getPlayerAttributes };
