# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- Acceptance/CI image updated to `noplexzone/reelscore:develop`. Stable semver tags and `latest` are reserved for future promoted releases.
- Custom in-memory rate limiter replaced with `express-rate-limit` ^7 (20 req / 15 min window on `/login` and `/register`).
- `parsePositiveInt` extracted to `server/src/validation.js`; POST `/watches` and DELETE `/watches/:id` now validate with it (400 on bad input, 404 when no owned entry is removed).
- `voteAverage` fallback changed from `|| 5` to `?? 5` so an explicit TMDB rating of 0 correctly yields 0 points.
- Delete-watch confirmation text updated to: "Remove this watch entry? Earned achievements remain unlocked."
- Local development commands updated from `npm install` to `npm ci`.
- Web dependencies bumped: react-router-dom 7.18.1, vite 8.1.5, @vitejs/plugin-react 6.0.4.

## [0.1.0] - 2026-07-27

### Added
- Core loop: search films via TMDB → log watches → earn points → unlock achievements → compare boards with friends.
- Point economy: `100 × (rating/10)² × clamp(runtime/120, 0.5, 2)`; rewatches pay 25%; same film within 30 days pays 0; soft daily cap of 26 runtime-hours.
- Achievement categories: series completion (TMDB collections), volume tiers (1/10/50/100/250 films), per-genre tiers (10/25/50 films), decade breadth (5/8/11 different decades), watch streaks (3/7/30 consecutive days).
- Social features: friend requests by username, friends leaderboard sorted by score, friends-are-watching feed.
- Profiles private by default; per-user public toggle.
- React 18 + Vite PWA frontend (installable on mobile via Web App Manifest).
- Single-container deploy: Node 22 + Express + SQLite (better-sqlite3); TMDB API proxied server-side with 6-hour in-memory cache.
- JWT auth with 30-day tokens; bcrypt password hashing.
- In-memory rate limiter on login/register (10 requests per 15 minutes per IP; replaced by express-rate-limit in Unreleased).
- Auth persisted across PWA launches via `localStorage` with automatic migration from legacy `sessionStorage`.
- Delete-watch UI on the movie detail page (browser-confirmed removal, local state updated immediately).
- Positive-integer validation for all TMDB route parameters; 400 response for invalid IDs.
- Validated `user_id` in `/friends/respond`; 400 response for non-positive values.
- Generic "Something went wrong." message for all 5xx responses (server detail logged only server-side).
- Hard startup failure in production when `JWT_SECRET` is not set.
- Automated tests (Node 22 built-in test runner) for scoring logic, JWT auth middleware, and route-param validation.
- GitHub Actions CI: server tests + audit, web build + audit on every push and pull request; Docker Hub publish on `main` only.
- Multi-stage Dockerfile using `npm ci` with lockfiles; linux/amd64 target.
- Docker Compose healthcheck (wget `/api/health`), OCI labels, and `image:` reference for pull-without-build.
- Root `.dockerignore`.
- `CHANGELOG.md` (this file).

### Notes
- v0.1 is an acceptance/development release. The Docker Hub image is published as `noplexzone/reelscore:develop`. Stable semver tags (e.g. `0.1.0`) and `latest` are reserved for future promoted releases.
- The `./data` bind mount must be writable by the container (runs as root by default). On Unraid, do not configure a non-root user mapping unless you have pre-created `./data` with matching ownership.
