# FC-26 Project Beta

## API

### `GET /api/players`

Fetch players from EA Pro Clubs. You may pass one or more club IDs as a comma-separated
`clubId`/`clubIds` query string. If omitted, the server falls back to the
`LEAGUE_CLUB_IDS` environment variable or a built-in default list.

The response shape is `{ members: [], byClub: { [clubId]: [] } }` where `members` is the
deduplicated union list and `byClub` maps each club ID to its members. Results are cached
for 60 seconds.

#### Environment

`LEAGUE_CLUB_IDS` – optional comma-separated club IDs overriding the built-in
default list used when the route is called without specifying a `clubId`.

## Logging

This project uses a Pino-based logger. Logs default to the `info` level. To see
verbose output, set a `LOG_LEVEL` environment variable before starting the
server, for example:

```bash
LOG_LEVEL=debug node server.js
```
