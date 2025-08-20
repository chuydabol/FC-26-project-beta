# FC-26 Project Beta

## API

### `GET /api/players`

Returns players from one or more EA Pro Clubs. Provide club IDs as a comma-separated
`clubId` query parameter, e.g. `/api/players?clubId=123,456`.

The server fetches each club, maps position codes using `proPos`, removes duplicates by
name, and responds with the combined player list.
