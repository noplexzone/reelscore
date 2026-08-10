# Reelscore

Movie watching as an achievements board. Log films, earn points, complete series,
unlock trophies, and compare boards with friends.

**v0.1 — acceptance/development release.** Core loop is playable end to end:
search → log → score → achievements → friends.

## The point economy

- Base points per watch: `100 × (rating/10)² × clamp(runtime/120, 0.5, 2)`
  — an average film lands around 40–60 pts, an acclaimed 3-hour epic near 150.
- Rewatches outside the 30-day cooldown pay **25%** of base; watches inside it pay 0.
- Pending, competitively excluded, and deleted watches do not qualify and do not move the cooldown clock.
- Lifetime totals come from the append-oriented score ledger; corrections append compensating events rather than rewriting awards.
- Achievements pay bonus points on top. See [`docs/SCORING.md`](docs/SCORING.md) for the complete eligibility and reconciliation contract.

## Achievements in v0.1

| Category | How it works |
| --- | --- |
| Series completion | Watch every released film in a TMDB collection → `250 + 50/film` bonus. Awards revoke if their qualifying basis is lost and reactivate with a new ledger generation when earned again. |
| Volume | 1 / 10 / 50 / 100 / 250 films logged |
| Genres | 10 / 25 / 50 films per genre (auto-generated per genre) |
| Decades | Films from 5 / 8 / 11 different decades |
| Streaks | 3 / 7 / 30 consecutive days with a watch |
| Filmographies | Watch a curated actor's or director's entire marquee filmography (Actors tab) → `500 + 25/film` bonus |

## Plex & Trakt sync

Link a service on your profile page and import your watch history — synced
films carry a **verified badge** proving they're really in your service's
history, unlike manually logged entries. When a newly imported provider event
matches an active manual entry for the same film and user-local calendar day,
it is quarantined from points, streaks, seasons, and trophies until the user
reviews it on the **Review** page. Every matching provider event receives its own
review case, so resolving one can never release another. The closest manual event
is selected by UTC time difference, then stable row ID. Provider retries remain
idempotent.

Duplicate decisions preserve both source rows and provenance: **Merge**
soft-deletes only the provider candidate and links it to the manual canonical
entry; **Keep both** applies normal rewatch/cooldown scoring; **Keep separate**
retains both diary rows but permanently excludes the unverified candidate from
competition; and **Keep both & ignore future matches** also suppresses future
cases for that user, film, and local day. Resolutions are atomic and replay-safe.
Timezone changes rebase fingerprints and scoped ignore rules transactionally. If a
timezone change or watch deletion removes the active manual/provider pairing, the
case closes with an explicit cancellation reason and scoring is reconciled.

- **Trakt** — requires the server admin to set `TRAKT_CLIENT_ID` /
  `TRAKT_CLIENT_SECRET` (free app at trakt.tv/oauth/applications). Linking uses
  the device-code flow: enter a short code at trakt.tv/activate.
- **Plex** — paste your server URL and an `X-Plex-Token`
  ([how to find yours](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)).
  Watched movies (with TMDB ids) import with their last-viewed dates.

## Social

- Friend requests by username; accepted friends see each other's boards.
- Friends leaderboard sorted by score, plus a "friends are watching" feed.
- Profiles are **private by default**; a per-user toggle makes them public.

## Run it (Docker)

1. Copy `.env.example` to `.env` and fill in:
   - `TMDB_API_KEY` — free from themoviedb.org (v3 key or v4 read token both work)
   - `JWT_SECRET` — a long random string, e.g. `openssl rand -hex 32`
2. `docker compose up -d --build`
3. Open `http://<host>:3210`, create an account, log a film.

SQLite lives in `./data` (mapped to `/data` in the container). Do not copy only the live database file: use the WAL-consistent, integrity-checked procedure in [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

### Pulling the published image

To run the pre-built image instead of building locally:

```bash
docker compose pull && docker compose up -d
```

The compose file references `noplexzone/reelscore:develop` (the acceptance/CI image).
Stable semver tags (e.g. `0.1.0`) and `latest` are reserved for future promoted releases.

### Unraid bind-mount note

The image runs as UID 99/GID 100. Pre-create the host data directory with matching ownership and writable permissions before first startup. A root-owned or read-only bind mount causes SQLite startup or migration failure.

### Local development (no Docker)

```bash
# Terminal 1 — API on :3000
cd server && npm ci
TMDB_API_KEY=yourkey JWT_SECRET=devonlysecret npm run dev

# Terminal 2 — web on :5173 (proxies /api to :3000)
cd web && npm ci && npm run dev
```

## Testing

```bash
# Server tests: scoring/ledger, eligibility, migrations, sync, auth, and security
cd server && npm test

# Web build verification
cd web && npm run build

# Dependency audits
cd server && npm audit --audit-level=high
cd web && npm audit --audit-level=high
```

Tests use Node 22's built-in test runner — no extra packages needed.

## Pull request workflow

1. Branch off `main`, make changes.
2. Push — GitHub Actions runs server tests + audit and web build + audit.
3. Open a pull request; all checks must pass before merge.
4. On merge to `main`, the publish job automatically builds and pushes `noplexzone/reelscore:develop` to Docker Hub. Stable semver/latest tags are reserved for promoted releases.

Required repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

## Architecture

- `server/` — Node 22 + Express + better-sqlite3. Opaque revocable cookie sessions with CSRF protection. TMDB is proxied server-side with an in-memory cache, so the API key never reaches the browser.
- `web/` — React 18 + Vite PWA. Installable on mobile (manifest + icon included); same UI serves desktop web. Served by the Express container in production.
- One container, one SQLite file. No external services beyond TMDB.

Watches retain manual/Plex/Trakt provenance and immutable provider-event identity. Normal sync is additive and idempotent; exact same-film/local-day manual-provider matches enter duplicate review before scoring.

## Roadmap (next runs)

- Curated collection achievements ("Best Picture winners", editorial lists) with an admin-managed list table
- Seasonal leagues and season-scoped score projections
- Weekly/monthly/seasonal leaderboards and challenges
- Competition-first dashboard and private league invitations
- Backdated logging (pick the watch date) and CSV/Letterboxd import
- Freemium gates: advanced stats, custom lists, profile themes

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
