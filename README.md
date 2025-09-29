# FC-26 Project Beta

## API

### `GET /api/players`

Returns the latest squad members stored in Postgres.
The response shape is `{ players: [...] }` where each player row contains
`player_id`, `club_id`, `name`, `position` and `last_seen`.

Player attribute snapshots are stored directly on the `players` table via the
`vproattr` column. When rendering cards, stats are parsed from `players.vproattr`
if available; otherwise a placeholder set is used.

The `/api/clubs/:clubId/player-cards` endpoint fetches club members from EA,
merges any stored attributes from `players`, and updates that table so aggregate
queries via `GET /api/players` stay in sync.

The `/api/clubs/:clubId/player-cards` endpoint fetches club members from EA,
merges any stored attributes, and updates the `players` table so aggregate
queries via `GET /api/players` stay in sync.

## Logging

This project uses a Pino-based logger. Logs default to the `info` level. To see
verbose output, set a `LOG_LEVEL` environment variable before starting the
server, for example:

```bash
LOG_LEVEL=debug node server.js
```

## Season Date Range

Endpoints that return league standings or leaderboards only consider matches
within a specific season window. By default the server uses the current season's
range, but you can override it with the `LEAGUE_START_MS` and
`LEAGUE_END_MS` environment variables. Each variable accepts either a Unix
millisecond timestamp or an ISO date string. For example:

```bash
LEAGUE_START_MS="2026-08-25T23:59:00-07:00" \
LEAGUE_END_MS="2026-09-01T23:59:00-07:00" \
node server.js
```

Update these variables at the start of each season to adjust the range. Use
`scripts/rebuildLeagueStandings.js` to refresh the `mv_league_standings`
materialized view.

## Resetting a Season

The `scripts/resetSeason.js` helper clears stored match data and zeros player
totals. Run it manually with:

```bash
node scripts/resetSeason.js
```

The server also exposes an admin-only endpoint to perform the same workflow:

```
POST /api/admin/reset-season
```

This route accepts either an authenticated admin session created via
`POST /api/admin/login` or an `x-admin-token` header that matches the
`ADMIN_TOKEN` environment variable. Ensure `ADMIN_PASSWORD`, `SESSION_SECRET`,
and (optionally) `ADMIN_TOKEN` are configured before invoking the reset.

## Card Assets

Place card frame PNGs in `public/assets/cards/` with the following names:
- `iron_rookie.png`
- `steel_card.png`
- `crimson_card.png`
- `obsidian_elite.png`

These files are ignored in git and must be supplied manually.
