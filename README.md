# FC-26 Project Beta

## API

### `GET /api/players`

Returns the latest squad members stored in Postgres.
The response shape is `{ players: [...] }` where each player row contains
`player_id`, `club_id`, `name`, `position` and `last_seen`.

Player attribute snapshots are stored in the `players` table via a `vproattr`
column (`player_id`, `club_id`, `name`, `position`, `vproattr`, `goals`,
`assists`, `last_seen`). When rendering cards, stats are parsed from this column
and merged with live EA data.

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
