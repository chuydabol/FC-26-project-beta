const { q } = require('../services/pgwrap');

const SQL_COMPUTE = `
  WITH club_match AS (
    SELECT
      c.cid::bigint AS club_id,
      (m.raw->'clubs'->c.cid->>'wins')::int    AS wins,
      (m.raw->'clubs'->c.cid->>'losses')::int  AS losses,
      (m.raw->'clubs'->c.cid->>'ties')::int    AS draws,
      (m.raw->'clubs'->c.cid->>'goals')::int   AS goals_for,
      (m.raw->'clubs'->o.opp_cid->>'goals')::int AS goals_against
    FROM public.matches m
    CROSS JOIN LATERAL jsonb_object_keys(m.raw->'clubs') AS c(cid)
    CROSS JOIN LATERAL (
      SELECT key AS opp_cid FROM jsonb_object_keys(m.raw->'clubs') key
      WHERE key <> c.cid
      LIMIT 1
    ) AS o
  )
  SELECT club_id,
         SUM(wins * 3 + draws) AS points,
         SUM(wins) AS wins,
         SUM(losses) AS losses,
         SUM(draws) AS draws,
         SUM(goals_for) AS goals_for,
         SUM(goals_against) AS goals_against
    FROM club_match
   GROUP BY club_id
`;

const SQL_UPSERT = `
  INSERT INTO public.league_standings
    (club_id, points, wins, losses, draws, goals_for, goals_against, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
  ON CONFLICT (club_id) DO UPDATE SET
    points = EXCLUDED.points,
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    draws = EXCLUDED.draws,
    goals_for = EXCLUDED.goals_for,
    goals_against = EXCLUDED.goals_against,
    updated_at = NOW()
`;

async function rebuildLeagueStandings() {
  const { rows } = await q(SQL_COMPUTE);
  for (const r of rows) {
    await q(SQL_UPSERT, [
      r.club_id,
      r.points,
      r.wins,
      r.losses,
      r.draws,
      r.goals_for,
      r.goals_against,
    ]);
  }
}

module.exports = { rebuildLeagueStandings };

if (require.main === module) {
  rebuildLeagueStandings()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
