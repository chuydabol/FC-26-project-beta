# FC-26 Project Beta

This repository has been reset into a minimal **Bota FC friendly match viewer**.
The current goal is intentionally small: show EAFC friendly matches for Bota FC
without storing matches, player IDs, player cards, rankings, news, admin tools,
or competition features.

## Current Team

- Club name: `Bota FC`
- EA club ID: `57985`
- EA match type: `friendlyMatch`

The active team can be overridden for local experiments with:

```bash
BOTA_CLUB_ID=57985 BOTA_CLUB_NAME="Bota FC" node server.js
```

## API

### `GET /api/health`

Returns basic service health and the active EA club configuration.

### `GET /api/team`

Returns the active team and match type.

### `GET /api/matches`

Fetches Bota FC friendly matches directly from EA and returns normalized match
cards for the website. No match data is written to storage.

### `GET /api/fixtures`

Alias for `GET /api/matches`, kept so the frontend can treat friendly matches as
fixtures while the project is rebuilt.

## Frontend

The root route `/` serves `public/teams.html`, which is now a single fixtures
view. Removed legacy UI areas include player cards, rankings, news, Champions
Cup, admin login, and multi-team pages.

## Development

```bash
npm test
npm start
```
