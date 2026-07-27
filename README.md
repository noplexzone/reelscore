# Reelscore

Movie watching as an achievements board. Log films, earn points, complete series,
unlock trophies, and compare boards with friends.

**v0.1 — first run.** Core loop is playable end to end: search → log → score →
achievements → friends.

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

## Run it

1. Copy `.env.example` to `.env` and fill in `TMDB_API_KEY` (free from
   themoviedb.org — v3 key or v4 read token both work) and a random `JWT_SECRET`.
2. `docker compose up -d --build`
3. Open `http://<host>:3210`, create an account, log a film.

SQLite lives in `./data` (mapped to `/data` in the container) — back that folder
up and you've backed up everything.

### Local development (no Docker)

```bash
# terminal 1 — API on :3000
cd server && npm install
TMDB_API_KEY=yourkey npm run dev

# terminal 2 — web on :5173 (proxies /api to :3000)
cd web && npm install && npm run dev
```

## Architecture

- `server/` — Node 22 + Express + better-sqlite3. JWT auth. TMDB proxied
  server-side with an in-memory cache (your API key never reaches the browser).
- `web/` — React 18 + Vite PWA. Installable on mobile (manifest + icon included);
  same UI serves desktop web. Served by the Express container in production.
- One container, one SQLite file. No external services beyond TMDB.

Watches carry a `source` column (`manual` today; `plex` / `trakt` reserved) so
scrobbling integrations can slot in without a migration.

## Roadmap (next runs)

- Curated collection achievements ("Best Picture winners", editorial lists) with
  an admin-managed list table
- Plex webhook + Trakt sync → verified watches
- Seasonal leaderboards to fight lifetime-score inflation
- Filmography achievements (directors/actors) via TMDB credits
- Backdated logging (pick the watch date) and CSV/Letterboxd import
- Freemium gates: advanced stats, custom lists, profile themes

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
