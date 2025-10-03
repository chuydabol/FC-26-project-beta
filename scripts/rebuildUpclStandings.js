const { q } = require('../services/pgwrap');

const SQL_LEAGUE_STANDINGS = `
  WITH matches AS (
    SELECT home.club_id::bigint AS home,
           away.club_id::bigint AS away,
           home.goals AS home_goals,
           away.goals AS away_goals
      FROM public.matches m
      JOIN public.match_participants home
        ON home.match_id::bigint = m.match_id::bigint AND home.is_home = true
      JOIN public.match_participants away
        ON away.match_id::bigint = m.match_id::bigint AND away.is_home = false
  ), sides AS (
    SELECT home AS club_id, away AS opp_id, home_goals AS gf, away_goals AS ga
      FROM matches
    UNION ALL
    SELECT away AS club_id, home AS opp_id, away_goals AS gf, home_goals AS ga
      FROM matches
  )
  SELECT c.club_id AS club_id,
         COALESCE(COUNT(s.club_id), 0)::int AS played,
         COALESCE(SUM(CASE WHEN s.gf > s.ga THEN 1 ELSE 0 END), 0)::int AS wins,
         COALESCE(SUM(CASE WHEN s.gf = s.ga THEN 1 ELSE 0 END), 0)::int AS draws,
         COALESCE(SUM(CASE WHEN s.gf < s.ga THEN 1 ELSE 0 END), 0)::int AS losses,
         COALESCE(SUM(s.gf), 0)::int AS goals_for,
         COALESCE(SUM(s.ga), 0)::int AS goals_against,
         COALESCE(SUM(s.gf - s.ga), 0)::int AS goal_diff,
         COALESCE(SUM(CASE WHEN s.gf > s.ga THEN 3 WHEN s.gf = s.ga THEN 1 ELSE 0 END), 0)::int AS points
    FROM public.clubs c
    LEFT JOIN sides s ON c.club_id = s.club_id
   GROUP BY c.club_id
   ORDER BY points DESC, goal_diff DESC, goals_for DESC`;

const SQL_UPSERT_STANDING = `
  INSERT INTO public.upcl_standings (club_id, p, w, d, l, gf, ga, gd, pts, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
  ON CONFLICT (club_id) DO UPDATE SET
    p = EXCLUDED.p,
    w = EXCLUDED.w,
    d = EXCLUDED.d,
    l = EXCLUDED.l,
    gf = EXCLUDED.gf,
    ga = EXCLUDED.ga,
    gd = EXCLUDED.gd,
    pts = EXCLUDED.pts,
    updated_at = NOW()
`;

async function rebuildUpclStandings() {
  const { rows } = await q(SQL_LEAGUE_STANDINGS);
  for (const r of rows) {
    await q(SQL_UPSERT_STANDING, [
      r.club_id,
      r.played,
      r.wins,
      r.draws,
      r.losses,
      r.goals_for,
      r.goals_against,
      r.goal_diff,
      r.points,
    ]);
  }
}

module.exports = { rebuildUpclStandings };

if (require.main === module) {
  rebuildUpclStandings()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
