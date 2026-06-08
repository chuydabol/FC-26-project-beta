# FC-26 Project Beta

UPCL League Hub for viewing EAFC friendly fixtures, saved database matches,
conference tables, playoff previews, and protected admin match approval tools.

## Current Team

- Club name: `Bota FC`
- EA club ID: `57985`
- EA match type: `friendlyMatch`

The active team can be overridden for local experiments with:

```bash
BOTA_CLUB_ID=57985 BOTA_CLUB_NAME="Bota FC" node server.js
```

## Environment

Admin actions require an `ADMIN_PASSWORD` value. Backend admin middleware checks
this value against the `x-admin-password` request header and returns
`{ "error": "Unauthorized" }` with HTTP 401 when the header is missing or does
not match.

```bash
ADMIN_PASSWORD="replace-with-a-strong-password" npm start
```

## API

### Public routes

These routes do not require the admin password:

- `GET /api/health`
- `GET /api/team`
- `GET /api/matches`
- `GET /api/fixtures`
- `GET /api/db-matches`
- `GET /api/standings`
- `GET /api/news`

### Admin routes

These routes require the `x-admin-password` header:

- `GET /api/pending-matches`
- `POST /api/sync-matches`
- `POST /api/matches/:matchId/approve`
- `POST /api/matches/:matchId/reject`
- `POST /api/matches/:matchId/friendly`

## Frontend

The root route `/` serves `public/teams.html`, which includes Fixtures, Tables,
League Playoffs, and an Admin tab. The Admin tab shows a login screen until a
password is saved in `localStorage` as `adminPassword`; admin requests include
that value in the `x-admin-password` header. Logging out clears the stored
password.

## Development

```bash
npm test
npm start
```
