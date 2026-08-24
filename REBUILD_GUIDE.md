# UPCL League Hub — Complete Reconstruction Guide

This document is a blueprint for rebuilding the current project from scratch. It describes what is implemented **now**, the exact data flow from EA, the storage and approval model, every visible page, the known static/mock areas, and a practical local-first build order.

## 1. Product snapshot

The app is a single-page UPCL league website for EA Sports FC Pro Clubs. It currently provides:

- an overview/news landing page;
- a live EA friendly-match feed for one configured club;
- a local database archive of matches fetched for all registered clubs;
- an admin moderation workflow that classifies a fetched match as league, friendly, or rejected;
- conference standings calculated only from approved league matches;
- player leaderboards calculated from player data embedded in approved EA match payloads;
- an EA-powered team/roster browser;
- a two-week static schedule mock-up; and
- a static playoff bracket whose records are enriched from the live standings.

The implementation is deliberately small: Node.js 18+, Express, PostgreSQL through `pg`, and one self-contained HTML file with inline CSS and vanilla JavaScript. There is no frontend framework, template engine, bundler, authentication session, job queue, or migration tool.

## 2. Source map

| Path | Responsibility |
|---|---|
| `server.js` | Express server, league configuration, normalization, standings calculation, public/admin JSON routes, root HTML route, and custom asset delivery. |
| `services/eaApi.js` | EA endpoint construction, headers, timeout/retry/cache behavior, payload flattening, and roster normalization. |
| `db.js` | Lazy PostgreSQL connection, schema creation/alteration, match and player-stat persistence, moderation updates, and aggregate player-stat query. |
| `public/teams.html` | The entire frontend: markup, styles, static schedule/playoffs/team metadata, render functions, API calls, and interactions. |
| `public/assets/` | UPCL art, trophy, silhouettes, and current/legacy club logos. |
| `data/leagueClubs.json` | Conference-to-club-ID lists. Runtime code currently duplicates this configuration instead of importing it. |
| `data/teams.json` | Six-team display data with abbreviated names. Also not imported at runtime. |
| `logger.js` | Minimal structured console logger. |
| `utils.js` | Small shared utility file. |
| `test/` | Node test-runner coverage for EA payload parsing, database stat normalization, server routes, auth, sync, standings, and moderation. |

Important reconstruction detail: club configuration currently exists in several places (`server.js`, `db.js`, `public/teams.html`, and `data/*.json`). A faithful clone can preserve that, but a maintainable rebuild should create one canonical league configuration module or local database table and expose it to the browser.

## 3. Current league and every team name used

### 3.1 The six registered clubs (used for syncing, standings, stats filtering, and rosters)

| Conference | Canonical name | EA club ID | Accepted/display aliases |
|---|---|---:|---|
| East | Bota FC | `57985` | `Bota FC`, `Bota` |
| East | Inferign United | `6297844` | `Inferign United`, `Inferign Utd` |
| East | True Egoistas | `1171188` | `True Egoistas`, `Egoistas` |
| West | Versus One | `4671025` | `Versus One` |
| West | FC Wisconsin | `654142` | `FC Wisconsin`, legacy misspelling `FC Wisconson` |
| West | FC Sutton St | `129307` | `FC Sutton St`, `FC Sutton` |

Bota FC is the default single club shown by the live Fixtures feed. `BOTA_CLUB_ID` and `BOTA_CLUB_NAME` may override it, but the six-club league list is fixed in source.

### 3.2 Other team names still present in UI/static data/assets

These are **not** registered in the current six-team backend league, so their games cannot affect standings or approved-league player stats:

- Royal Republic
- Sporting de la MA
- Razorblack FC
- Elite VT
- AFC Warriors
- Club Frijol
- Everything Dead
- FC Dhizz
- Jids Trivela
- Khalch FC
- Real MVC
- Rooney Tunes

The first four appear in the static two-week schedule. Several others survive only as logo assets from earlier development. Treat them as legacy/reference material unless expanding the league.

## 4. EA API integration, exactly as implemented

### 4.1 Base and direct endpoint links

The unofficial/public EA Pro Clubs base used by the app is:

- `https://proclubs.ea.com/api/fc`

Match history template:

- `https://proclubs.ea.com/api/fc/clubs/matches?matchType=friendlyMatch&platform=common-gen5&clubIds={CLUB_ID}`
- Bota example: `https://proclubs.ea.com/api/fc/clubs/matches?matchType=friendlyMatch&platform=common-gen5&clubIds=57985`

Member-stat template:

- `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId={CLUB_ID}`
- Bota example: `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=57985`

This code assumes current-generation cross-platform club data (`platform=common-gen5`) and uses `friendlyMatch`. The EA endpoints are not controlled by this project; response shapes or availability can change.

### 4.2 Request behavior

Send these headers:

```http
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
Accept: application/json
Referer: https://www.ea.com/
```

The service:

1. validates club IDs with `^\d+$`;
2. creates query strings with `URLSearchParams`;
3. uses the built-in Node `fetch` API;
4. aborts after `EA_TIMEOUT_MS` (default `25000` ms);
5. retries twice after the first attempt (three attempts total) only for aborts, HTTP 408, 429, and 5xx responses;
6. waits 500 ms before retry 1 and 1000 ms before retry 2;
7. keeps an in-process memory cache for `EA_CACHE_TTL_MS` (default `60000` ms); and
8. uses cache keys `{matchType}:{clubId}` and `members:{clubId}`.

The declared HTTPS keep-alive agent has four sockets. Note that Node's built-in `fetch` is based on Undici and does not use the legacy `agent` option in the same way as `https.request`; a new build should either omit this option or explicitly configure an Undici dispatcher.

### 4.3 Accepted EA match payload shapes

EA responses have varied, so the parser recursively accepts:

```js
[match]
[[match], [match]]
{ "57985": [match] }
{ "matches": [match] }
```

A value counts as a match object when it has at least one of `matchId`, `matchid`, `id`, `clubs`, or `players`. Nested arrays are flattened. Duplicate objects with the same `matchId`/`matchid`/`id` are removed; objects with no ID are retained.

### 4.4 Match normalization

For each raw match:

- ID: first of `match.matchId`, `match.matchid`, `match.id`; otherwise `{sourceClubId}-friendly-{arrayIndex}`.
- Time: first of `timestamp`, `ts_ms`, `timeAgo`, or `date`. Values at or below `1_000_000_000_000` are treated as Unix seconds and multiplied by 1000; larger values are milliseconds.
- Clubs: iterate `match.clubs`; name comes from `details.name`, `details.clubName`, or `Club {id}`.
- Score: use club-level `club.goals`, then `club.score`, then `details.goals`. Do **not** sum player goals; this matters for DNF results.
- Home status: true when `details.isHome` is boolean/string true or `details.side === 'home'`.
- The source club is found by exact club ID; the first other club is the opponent.
- Result is `W`, `L`, or `D` by comparing those two club-level scores.
- Preserve the entire EA object as `raw`; this is essential because later player-stat extraction reads `raw.players`.

Normalized response shape:

```json
{
  "id": "EA match ID",
  "timestamp": 1700000000000,
  "team": { "id": "57985", "name": "Bota FC", "goals": 2, "isHome": true },
  "opponent": { "id": "123", "name": "Opponent FC", "goals": 1, "isHome": false },
  "clubs": [],
  "score": { "for": 2, "against": 1 },
  "result": "W",
  "raw": {}
}
```

### 4.5 Member normalization

The roster endpoint expects `{ members: [], positionCount: {} }`. Missing/invalid data becomes empty collections. Each member is normalized to:

- `id`: `id`, `userId`, `personaId`, or generated `{name}-{index}`;
- `name`: `name`, `playerName`, `proName`, or `Player N`;
- numeric: `gamesPlayed`, `winRate`, `goals`, `assists`, `passesMade`, `passSuccessRate`, `ratingAve`, `tacklesMade`, `tackleSuccessRate`, `manOfTheMatch`, `redCards`, `proOverall`;
- text: `favoritePosition` (default `N/A`), `proName`, and `proOverallStr` (default em dash).

## 5. Local-first storage and the match lifecycle

### 5.1 Recommended faithful local setup: PostgreSQL

Install Node 18+ and PostgreSQL, then run:

```bash
createdb upcl
cp .env .env.local  # or create your own untracked environment file
export DATABASE_URL='postgresql://localhost/upcl'
export ADMIN_PASSWORD='replace-with-a-long-local-password'
export LEAGUE_CLUB_IDS='57985,6297844,1171188,4671025,654142,129307'
export LEAGUE_START_MS='0'
export LEAGUE_END_MS='4102444800000'
npm install
npm start
```

Open `http://localhost:3000`. The server lazily creates tables when a database-backed route is first used, so no separate migration command currently exists. Local PostgreSQL disables TLS; non-local URLs use TLS with certificate verification disabled.

Do not commit real passwords or database credentials. The repository currently tracks a sample-like `.env`, but a rebuild should commit `.env.example` and ignore `.env*` except that example.

### 5.2 Schema

`matches`:

| Column | Type/default | Meaning |
|---|---|---|
| `id` | `serial primary key` | Local row ID. |
| `match_id` | `text unique not null` | EA identity and deduplication key. |
| `source_club_id` | `text not null` | Registered club whose feed discovered the match. |
| `club_name`, `opponent_name` | `text` | Names at fetch time. |
| `club_score`, `opponent_score` | `integer` | Club-level official score. |
| `result` | `text` | W/L/D from source club's perspective. |
| `match_date` | `timestamp` | Normalized EA time. |
| `raw_json` | `jsonb` | Complete unmodified EA payload. |
| `created_at` | `timestamp default now()` | Local ingestion time. |
| `status` | `text default 'pending'` | `pending`, `approved`, or `rejected`. |
| `competition` | `text default 'friendly'` | `league` or `friendly`. |
| `matchday` | `integer` | Optional positive integer. |
| `series_id` | `text` | Reserved; not currently populated by UI/routes. |
| `notes` | `text` | Optional admin notes. |

`players`:

| Column | Type/default |
|---|---|
| `id` | `serial primary key` |
| `ea_player_id` | `text unique` |
| `player_name` | `text not null` |
| `club_id`, `club_name`, `position`, `avatar_url` | `text` |
| `active` | `boolean default true` |
| `created_at` | `timestamp default now()` |

`player_match_stats`:

| Column | Type/default |
|---|---|
| `id` | `serial primary key` |
| `match_id` | `text not null` |
| `ea_player_id`, `club_id`, `club_name` | `text` |
| `player_name` | `text not null` |
| `goals`, `assists`, `passes_attempted`, `passes_made`, `tackles_attempted`, `tackles_made` | `integer default 0` |
| `man_of_the_match` | `boolean default false` |
| `raw_json` | `jsonb` |
| `created_at` | `timestamp default now()` |
| uniqueness | `(match_id, ea_player_id)` |

The database does not currently declare foreign keys between these tables.

### 5.3 Ingestion and moderation lifecycle

1. An administrator presses **Sync Matches to Database** on Fixtures (or calls `POST /api/sync-matches`).
2. The server sequentially fetches `friendlyMatch` history for all six registered club IDs.
3. Every raw match is normalized from that source club's perspective.
4. `matches` inserts with `status='pending'`, `competition='friendly'`; `ON CONFLICT (match_id) DO NOTHING` deduplicates the same match discovered in both teams' feeds.
5. Player rows are still upserted even when the match row already existed. This refreshes player and per-match stats from the raw payload.
6. The Admin page lists pending rows. Each may become:
   - **Approve League** → `status='approved'`, `competition='league'`;
   - **Keep Friendly** → `status='approved'`, `competition='friendly'`; or
   - **Reject** → `status='rejected'`, competition left as supplied/default.
7. Only approved league matches affect standings and player leaderboards.
8. **Reset Approved Matches** returns every approved row to pending, clears `matchday`, `series_id`, and `notes`, and resets competition to friendly.
9. **Backfill Player Stats** revisits all `matches.raw_json` and upserts any embedded players. Use it after schema upgrades or if old matches existed before player-stat storage.

### 5.4 EA player fields extracted from a match

Within `raw.players`, the structure is `{clubId: {playerId: playerObject}}`. Club name comes from `raw.clubs[clubId].details.name`. Required fields are nested player key and `player.playername`; misleading fields inside the object are deliberately ignored. Mappings:

- `pos` → position
- `goals` → goals
- `assists` → assists
- `passattempts` / `passesmade`
- `tackleattempts` / `tacklesmade`
- `mom === '1'` → man of the match

### 5.5 Player leaderboard aggregation

Stats are not simply aggregated for every approved row. The query first verifies that both match names resolve to two different registered UPCL clubs through normalized aliases. It then groups by EA player ID (falling back to name), counts distinct match IDs, sums totals, and calculates pass/tackle completion percentages. Sort order is goals descending, assists descending, MOTM descending, then name ascending.

### 5.6 If you want SQLite instead

For maximum local portability, replace `pg` with `better-sqlite3` or Node's supported SQLite option, store the file under an ignored `local-data/` directory, translate `serial/jsonb/now()/regexp_replace/RETURNING (xmax=0)` to SQLite equivalents, and use `INSERT ... ON CONFLICT DO UPDATE`. Keep the three logical tables and lifecycle above unchanged. PostgreSQL is the least work and is the exact current behavior; SQLite requires rewriting `db.js` and its tests.

## 6. Internal HTTP API contract

All JSON routes allow cross-origin access (`*`) and GET/HEAD/POST preflights. JSON request bodies are capped at 1 MB.

### Public routes

| Method/path | Success response/purpose |
|---|---|
| `GET /api/health` | `{ok:true, team, matchType:'friendlyMatch'}`. |
| `GET /api/team` | Configured single live-feed team and match type. |
| `GET /api/news` | Static news items, including a demonstration standings-movement graphic. |
| `GET /api/matches` | Live EA matches for configured Bota/default club, newest first. |
| `GET /api/fixtures` | Exact alias of `/api/matches`. |
| `GET /api/db-matches` | `{matches:[...]}` containing all locally saved statuses/competitions. |
| `GET /api/standings` | `{east:[...], west:[...]}` derived from approved league rows. |
| `GET /api/player-stats` | `{players:[...]}` aggregate approved-league leaderboard. |
| `GET /api/teams/:clubId/members` | EA roster plus conference and record; only the six registered IDs are accepted. |

EA failure routes return 502; database failure routes generally return 500 and include `error`, `details`, and an empty fallback collection.

### Admin routes

Every request must include:

```http
x-admin-password: value-of-ADMIN_PASSWORD
```

Missing server configuration, missing header, or mismatch returns HTTP 401 `{ "error": "Unauthorized" }`.

| Method/path | Body | Effect |
|---|---|---|
| `GET /api/pending-matches` | — | Pending queue. |
| `POST /api/sync-matches` | — | Fetch all six clubs and return `{totalFetched, inserted, skipped}`. |
| `POST /api/matches/:matchId/approve` | `{competition:"league", matchday?, notes?}` | Approve as league (competition may also be friendly). |
| `POST /api/matches/:matchId/friendly` | `{matchday?, notes?}` | Approve but exclude from league. |
| `POST /api/matches/:matchId/reject` | `{notes?}` | Reject. |
| `POST /api/admin/reset-approved-matches` | — | Return approved rows to pending. |
| `POST /api/admin/backfill-player-stats` | — | Re-extract players from all raw match JSON. |

Competition accepts only `league` or `friendly`; matchday, if present, must be a positive integer. Unknown match IDs return 404.

Example local flow:

```bash
curl http://localhost:3000/api/health
curl -X POST -H 'x-admin-password: replace-with-a-long-local-password' http://localhost:3000/api/sync-matches
curl -H 'x-admin-password: replace-with-a-long-local-password' http://localhost:3000/api/pending-matches
curl -X POST -H 'Content-Type: application/json' \
  -H 'x-admin-password: replace-with-a-long-local-password' \
  -d '{"competition":"league","matchday":1,"notes":"Verified by league office"}' \
  http://localhost:3000/api/matches/EA_MATCH_ID/approve
curl http://localhost:3000/api/standings
```

## 7. Standings rules

- Begin with all six registered teams at zero.
- Read only `status='approved' AND competition='league'` rows.
- Resolve both stored names through aliases and ignore matches with an unknown team or a team playing itself.
- Award 3 points for a win, 1 for a draw, 0 for a loss.
- Track played, wins, draws, losses, goals for/against, and goal difference.
- Form contains the five most recent W/D/L results based on match date, falling back to row ID.
- Rank independently per conference by points, goal difference, goals for, then alphabetic team name.
- Seeds are assigned after sorting, starting at 1.

No head-to-head, forfeiture adjustment, series scoring, playoff qualification calculation, season boundary, or manual table correction is currently implemented. The `.env` season-window variables are described but are not read by current runtime code.

## 8. Frontend architecture and visual system

### 8.1 Shell and visual language

`GET /` reads and returns `public/teams.html`. Assets are served only under `/assets/` by a custom traversal-safe handler supporting PNG, JPG/JPEG, and SVG. The page is one HTML document with roughly 3,200 lines of inline CSS and roughly 1,200 lines of inline JavaScript.

The design is an EA/broadcast-style black/red/white league presentation:

- primary red `#c00000`, dark red `#7a0000`, deep red `#3a0000`;
- black `#080808`, panels `#111111` / `#1a1a1a`;
- white text, muted `#cfcfcf`;
- green wins `#00d26a`, amber draws `#ffb300`, red losses `#ff4b4b`;
- uppercase, heavy typography, clipped/skewed card edges, diagonal gradients, glow, grid/dot texture, and broadcast chips;
- responsive breakpoints at 920 px and 720 px;
- reduced-motion support;
- animated trophy glow/float, bracket pulse/line travel, and playoff particles.

The top hero contains the kicker **UPCL League Hub**, huge outlined **UPCL League** title, league description, chips for two conferences/BO3 series/EA FC 26, and the UPCL logo in a skewed crest card. Below is a horizontally scrollable tab bar.

Tab switching simply toggles `.active` on the matching button and `{tabName}-panel`; it does not modify the URL or browser history.

### 8.2 Overview tab

Two-column broadcast dashboard with a main stack and news sidebar:

- **Conference Snapshot**: dynamically renders East and West mini tables from `/api/standings`.
- **Live / Recent Series**: currently static mock score cards (Bota FC vs FC Wisconsin; Versus One vs Inferign United).
- **Upcoming Series**: static True Egoistas vs FC Sutton St card.
- **League Leaders**: compact leaders populated from `/api/player-stats`.
- **UPCL News Center**: initially includes four static preseason cards, then loads `/api/news`. Categories choose icons. A special `standingsMovement` news graphic renders rank movement arrows, points/GD/form, playoff cutoff, and decorative mini panels for form, region, and point bars.

Be careful: the backend news array also contains illustrative standings rows for eight teams and nonzero points. This is a **news graphic demonstration**, not official standings.

### 8.3 Fixtures tab

- Toolbar identifies the configured live-feed team, status, **Refresh Matches**, and **Sync Matches to Database** buttons.
- Live list calls `/api/matches` and shows result badge, opponent, `for-against` score, and formatted date.
- Empty and error states render inline.
- **Database Matches** subsection calls `/api/db-matches` and displays every saved row with score, date, status, competition, and matchday metadata.
- Refresh only refetches live EA data; sync is admin-protected and uses the locally stored password.

### 8.4 Schedule tab

A polished but currently static UI, not database-connected:

- hero labeled **UPCL Matchweek View**;
- Week/Calendar view toggle (calendar is essentially a separate container; the detailed data is in Week view);
- filters: All, Eastern, Western, Bota FC;
- two matchweeks, five series each;
- each series is a best-of-three presentation with game markers, day name, conference, home/away logos, and Scheduled state.

Current hard-coded schedule:

| Week | Series | Day | Conference | Home | Away |
|---:|---:|---|---|---|---|
| 1 | 1 | Wednesday | East | Bota FC | Inferign Utd |
| 1 | 2 | Thursday | West | Versus One | FC Wisconsin |
| 1 | 3 | Friday | East | Egoistas | Royal Republic |
| 1 | 4 | Saturday | West | FC Sutton | Razorblack FC |
| 1 | 5 | Sunday | East | Sporting de la MA | Bota FC |
| 2 | 6 | Wednesday | West | Elite VT | Versus One |
| 2 | 7 | Thursday | East | Inferign Utd | Egoistas |
| 2 | 8 | Friday | West | FC Wisconsin | Elite VT |
| 2 | 9 | Saturday | East | Royal Republic | Sporting de la MA |
| 2 | 10 | Sunday | West | Razorblack FC | FC Sutton |

This conflicts with the current six-team backend roster. Decide whether to restore those four teams or replace these fixtures before treating this as an official schedule.

### 8.5 Tables tab

`/api/standings` renders one card per conference. Columns/values include seed, team with logo, played, wins, draws, losses, goals for, goals against, goal difference, points, and up-to-five form badges. It has loading, empty, and failure states. The overview and playoff views reuse the same in-memory standings payload.

### 8.6 Player Stats tab (current stopping point/detail)

This is fully wired to locally stored approved league player data, not the live member totals:

1. **Player Stat Leaders** has winner cards for goals, assists, pass percentage, tackle percentage, MOTM count, and league matches.
2. **Player Leaderboard** has selectable metric pills for those same six fields.
3. Each leaderboard row shows rank, player name, club name, chosen value, and a proportional horizontal bar relative to the current maximum.
4. Percentage values use one decimal plus `%`; counts are integers.
5. League matches falls back to `matches_played` for compatibility.
6. Sorting is descending on selected metric, then player name.
7. Data only includes matches where both clubs are registered, the match is approved, and competition is league.
8. Loading/error/empty copy explains that approved league matches with EA player data are required.

The page does not yet provide season filters, per-match drilldowns, goalkeeper-specific stats, cards beyond member red-card display, minutes, charts over time, manual stat corrections, avatars, or export.

### 8.7 Teams tab

- Six-card UPCL team grid, grouped visually with conference name, club ID label, logo, and current standings record.
- Clicking a club calls `/api/teams/:clubId/members`; results are cached in a browser `Map` for the session.
- Detail hero includes back control, logo, canonical team name, conference, record, roster count, and position counts/source metadata.
- Roster appears as an EA-card-inspired horizontal carousel/stage. Each card uses `SIL1.png`, player overall, position, player/pro name, goals, assists, games, rating, and performance data.
- Clicking, hovering, Enter, or Space activates a card.
- Active-player detail provides richer figures and bar graphs; stat bars use field-specific normalization maxima.
- An accolades panel is explicitly mock presentation content and can be toggled.
- Previous/next controls rotate through the roster.
- Includes loading and error team-detail states and a back-to-hub action.

There is no locally managed roster: team details are dependent on EA at request time, though the browser caches successful responses until reload.

### 8.8 League Playoffs tab

Static championship stage with animated background, desktop bracket, mobile timeline, connectors, BO3 labels, and trophy SVG. Current structure:

- East play-in: #2 Inferign United vs #3 True Egoistas;
- East final: #1 Bota FC vs play-in winner;
- West play-in: #2 FC Wisconsin vs #3 FC Sutton St;
- West final: #1 Versus One vs play-in winner;
- UPCL final: East Champion vs West Champion.

Team records are enriched from standings where names match, but seeds, participants, winners, and progression are hard-coded. No bracket result persistence or advancement logic exists.

### 8.9 Admin tab

Logged-out state shows a password input and Login button. Login merely saves plaintext to browser `localStorage` under `adminPassword`; every admin fetch copies it into `x-admin-password`. A 401 clears it and returns to login. Logout removes it.

Logged-in dashboard provides:

- pending-match list;
- Approve League, Keep Friendly, and Reject buttons per match;
- Sync Matches (located on Fixtures);
- Backfill Player Stats;
- Reset Approved Matches; and
- status/progress/error copy.

This is shared-secret protection, not user authentication. There are no accounts, roles, rate limits, CSRF controls, secure cookies, audit log, or brute-force protection. It is reasonable for trusted localhost use; strengthen it before internet exposure.

## 9. Assets to copy

Core currently referenced art:

- `public/assets/logos/UPCL.png` — hero crest;
- `public/assets/logos/league-crest.png` — fallback and most current teams;
- `public/assets/championship-trophy.svg` — playoff trophy;
- `public/assets/SIL1.png` — roster cards;
- `public/assets/SIL2.png` — alternate silhouette asset;
- named legacy/team PNGs under `public/assets/logos/`.

The `teamLogos` map deliberately falls back to `league-crest.png`, so most registered teams do not yet have unique crests. `public/assets/bnm` has no extension and is not used by the current page. Card-frame PNGs are gitignored, so do not design a rebuild that silently depends on untracked frames.

## 10. Startup and initialization sequence

At the end of the HTML script, reproduce this logical order:

1. wire tab, schedule filter/view, leaderboard metric, team card/detail, refresh, sync, admin, and pending-match handlers;
2. render schedule weeks;
3. render team grid;
4. render playoff bracket/layers;
5. render current admin logged-in/out state from local storage;
6. start loading news, standings, player stats, live matches, and database matches.

The browser escapes dynamic text before inserting templates. Preserve that rule for EA, database, and admin-provided strings.

## 11. Recommended clean rebuild order

1. **Create one league config source** with ID, canonical name, aliases, conference, and logo for every club.
2. **Create local database migrations** for the three existing tables plus `clubs`, `seasons`, `series`, and `scheduled_matches` if schedule/playoff management is desired.
3. **Port the EA client** with validation, headers, retry/timeout, normalized response parsing, deduplication, and raw-payload retention.
4. **Implement ingestion** as an explicit admin command; consider a local cron job after manual sync works.
5. **Implement moderation** and ensure no fetched friendly affects official results before approval.
6. **Implement standings** with documented tie-breakers and tests.
7. **Implement player extraction/aggregation** and backfill before building the stats UI.
8. **Build the API contracts** listed above; retain predictable empty arrays in error responses if cloning frontend behavior.
9. **Port the shared page shell and visual tokens**, then Overview, Fixtures, Tables, Stats, Teams, Schedule, Playoffs, Admin in that order.
10. **Replace static schedule and bracket** with database-backed entities, or label them clearly as mock/preseason.
11. **Add local backups** (`pg_dump upcl > backups/upcl-YYYY-MM-DD.sql`) and test restore.
12. **Add security** only as needed for deployment; on localhost, bind to `127.0.0.1` if it should not be LAN-accessible.

## 12. Gaps and traps to fix rather than unknowingly reproduce

- Club definitions are duplicated and can drift (the JSON files use abbreviated names while runtime uses canonical names).
- Schedule contains four clubs outside the registered backend league.
- Several “recent/upcoming” overview score cards are static demonstration content.
- The news movement graphic uses invented eight-team standings and must not be mistaken for official data.
- Schedule calendar mode, series linkage, bracket advancement, and `series_id` are unfinished.
- `LEAGUE_CLUB_IDS`, `LEAGUE_START_MS`, and `LEAGUE_END_MS` exist in environment documentation but current runtime does not use them.
- Sync fetches clubs sequentially and has no pagination, background job, last-sync record, or persisted EA response cache.
- EA response caching is memory-only and disappears on restart.
- A duplicate match discovered from the other club's feed keeps whichever source inserted first.
- Player stats are upserted outside a database transaction with match insertion.
- Raw match/player JSON may contain more personal/game data than you need; decide a retention policy.
- PostgreSQL tables are evolved with ad-hoc `CREATE/ALTER` calls rather than versioned migrations.
- Admin password lives in plaintext local storage and is sent on every admin request.
- CORS permits every origin.
- The custom static handler only serves the asset extensions it recognizes; it does not serve arbitrary public files.
- There is no automated browser/UI test suite, only backend/unit tests.

## 13. Validation checklist for the new local build

- [ ] All six club IDs return either a valid EA response or a handled 502.
- [ ] A nested EA payload is flattened and duplicate match IDs are removed.
- [ ] DNF score uses club score, not the sum of player goals.
- [ ] Re-sync produces skips rather than duplicate matches.
- [ ] Every new match begins pending/friendly.
- [ ] Unknown opponents never affect standings or aggregate league stats.
- [ ] Approving one intra-league result updates both teams and form correctly.
- [ ] Friendly/rejected rows remain visible in the archive but not the table.
- [ ] Player totals change only when an eligible approved league match is present.
- [ ] Backfill is idempotent.
- [ ] All dynamic EA/database strings are HTML-escaped.
- [ ] Mobile layouts work below 920 px and 720 px; reduced-motion preference is respected.
- [ ] Admin endpoints return 401 without the header.
- [ ] Database backup and restore have both been tested.
- [ ] Static/mock Overview, Schedule, News Graphic, accolades, and Playoffs content is either replaced or clearly labeled.

## 14. Existing automated checks

Run from the repository root:

```bash
npm install
npm test
```

Tests use Node's built-in `node:test`, mock the EA/database boundaries, and do not require a live EA request or local PostgreSQL for their covered paths. When extending the rebuild, add integration tests against a disposable local database and saved EA fixture JSON before changing normalization or schema behavior.
