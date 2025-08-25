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

## Logging

This project uses a Pino-based logger. Logs default to the `info` level. To see
verbose output, set a `LOG_LEVEL` environment variable before starting the
server, for example:

```bash
LOG_LEVEL=debug node server.js
```

## Card Assets

Place card frame PNGs in `public/assets/cards/` with the following names:
- `iron_rookie.png`
- `steel_card.png`
- `crimson_card.png`
- `obsidian_elite.png`

These files are ignored in git and must be supplied manually.
