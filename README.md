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

When importing fixtures from EA the server ignores matches that occurred before
`LEAGUE_START_MS`. The default value reflects the current season's opening day,
but you can override it with an environment variable. The variable accepts
either a Unix millisecond timestamp or an ISO date string. For example:

```bash
LEAGUE_START_MS="2026-08-25T23:59:00-07:00" \
node server.js
```

Update this variable at the start of each season to adjust the import window.
Use `scripts/rebuildLeagueStandings.js` to refresh the `mv_league_standings`
materialized view.

## Card Assets

Place card frame PNGs in `public/assets/cards/` with the following names:
- `iron_rookie.png`
- `steel_card.png`
- `crimson_card.png`
- `obsidian_elite.png`

These files are ignored in git and must be supplied manually.
