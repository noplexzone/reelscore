# Reelscore

Movie watching as an achievements board. Log films, earn points, complete series,
unlock trophies, and compare boards with friends.

**v0.1 — acceptance/development release.** Core loop is playable end to end:
search → log → score → achievements → friends.

## The point economy

- Base points per watch: `100 × (rating/10)² × clamp(runtime/120, 0.5, 2)`
  — an average film lands around 40–60 pts, an acclaimed 3-hour epic near 150.
- Rewatches pay **25%** of base. Rewatching the same film within **30 days** pays 0.
- Soft anti-abuse: max 26 hours of logged runtime per day.
- Achievements pay bonus points on top (see `server/src/achievements.js`).

## Achievements in v0.1

| Category | How it works |
| --- | --- |
| Series completion | Watch every released film in a TMDB collection → `250 + 50/film` bonus. Completions are permanent. |
| Volume | 1 / 10 / 50 / 100 / 250 films logged |
| Genres | 10 / 25 / 50 films per genre (auto-generated per genre) |
| Decades | Films from 5 / 8 / 11 different decades |
| Streaks | 3 / 7 / 30 consecutive days with a watch |

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

SQLite lives in `./data` (mapped to `/data` in the container) — back that folder up and you've backed up everything.

### Pulling the published image

To run the pre-built image instead of building locally:

```bash
docker compose pull && docker compose up -d
```

The compose file references `noplexzone/reelscore:develop` (the acceptance/CI image).
Stable semver tags (e.g. `0.1.0`) and `latest` are reserved for future promoted releases.

### Unraid bind-mount note

The container runs as root by default. The `./data` directory is created by Docker Compose automatically. **Do not configure a non-root UID/GID mapping** in Unraid's container settings for v0.1 unless you have pre-created `./data` with matching ownership — doing so will cause SQLite writes to fail.

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
# Server unit tests (scoring, auth middleware, route-param validation)
cd server && npm test

# Web build verification
cd web && npm run build

# Dependency audits
cd server && npm audit
cd web && npm audit
```

Tests use Node 22's built-in test runner — no extra packages needed.

## Pull request workflow

1. Branch off `main`, make changes.
2. Push — GitHub Actions runs server tests + audit and web build + audit.
3. Open a pull request; all checks must pass before merge.
4. On merge to `main`, the publish job automatically builds and pushes `noplexzone/reelscore:develop` to Docker Hub. Stable semver/latest tags are reserved for promoted releases.

Required repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

## Architecture

- `server/` — Node 22 + Express + better-sqlite3. JWT auth. TMDB proxied server-side with an in-memory cache (your API key never reaches the browser).
- `web/` — React 18 + Vite PWA. Installable on mobile (manifest + icon included); same UI serves desktop web. Served by the Express container in production.
- One container, one SQLite file. No external services beyond TMDB.

Watches carry a `source` column (`manual` today; `plex` / `trakt` reserved) so scrobbling integrations can slot in without a migration.

## Roadmap (next runs)

- Curated collection achievements ("Best Picture winners", editorial lists) with an admin-managed list table
- Plex webhook + Trakt sync → verified watches
- Seasonal leaderboards to fight lifetime-score inflation
- Filmography achievements (directors/actors) via TMDB credits
- Backdated logging (pick the watch date) and CSV/Letterboxd import
- Freemium gates: advanced stats, custom lists, profile themes

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
