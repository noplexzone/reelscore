# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- Add private league frontend views for league creation/joining, leaderboard periods, season management, invite issuance, challenge definition, assignment, completion, and dashboard progress.
- Add private league challenge definition, assignment, completion, bonus, and dashboard API foundations.

- Add private league weekly, monthly, season, and lifetime leaderboard API foundations.
- Added append-only season score projection reconciliation with database-enforced source copying, reversal shape, archived-league freezing, immutable provider evidence, and atomic reconciliation across competitive watch, duplicate, settings, deletion, import, and membership-departure ingress.

### Added
- Audited owner-only diary entries with 0–100 personal ratings, reviews, private notes, favorites, normalized tags, venue, visibility, transactional manual watch-date reconciliation with ended/frozen seasons protected and provider-attested dates held read-only, and a secondary accessible Movie-page editor that leaves Quick Log unchanged.
- Verified-season projections now recognize placeholder-reconciled provider evidence through schema 12.
- Append-only audit storage enforced by schema 11 database triggers.
- Competitive season schema 9 with private league ownership, immutable membership episodes, immutable-capacity expiring invite audit, lockable participant snapshots, irreversible cancellation/finalization, frozen archived standings, non-overlapping seasons, source-linked append-only season score events, strict calendar-valid timestamps, canonical legacy-time migration, and immutable effective scoring chronology.
- Private league services and HTTP APIs for ownership, membership episodes, safe invite preview/acceptance, role management, transfer, and archival.
- Immutable season lifecycle services and private HTTP APIs with DST-safe league-local scheduling, non-overlapping half-open boundaries, owner/admin controls, replay-safe participant snapshots and cancellation, derived lifecycle states, departure cutoffs, and duplicate-aware finalization after a 72-hour grace period; finalization now transactionally reconciles all participant projections before freezing, with post-end grace filtering and an audited bounded owner/admin repair endpoint.
- Duplicate review workflow for same-user/manual-provider same-film local-day imports, with explicit per-provider cases, pending score quarantine, ownership-scoped API, atomic/idempotent merge and keep resolutions, timezone-safe scoped ignore rules, audited deletion/timezone cancellations, and a direct Review UI.
- User-selectable IANA timezones in account settings, with browser-zone detection and private `/api/me` exposure.
- Competitive-integrity migration 7 with timezone-normalized watch chronology, explicit versioned eligibility, an idempotent legacy score-ledger backfill, reversible-achievement references, and duplicate-review schema; plus migration 8 for explicit per-provider duplicate cases and audited system cancellations.
- Competitive-integrity architecture and phased implementation plan covering qualifying watches, an explainable/reversible score ledger, timezone-aware streaks, duplicate review, seasons, leagues, challenges, and later quality work.
- Authoritative scoring/eligibility documentation and WAL-consistent, integrity-checked backup/restore instructions with disposable rehearsal guidance.
- Optional authenticator-app TOTP MFA with one-use recovery codes, MFA-aware sign-in, administrator MFA safeguards, and account settings for enrollment, recovery-code rotation, MFA disable, and active-session revocation.
- Public hosted verified-account foundation: open email/password registration without pre-verification sessions, one-use HMAC-digested verification/reset tokens with exact epoch-millisecond expiry, encrypted durable email outbox jobs, generic resend/reset responses, legacy-account email claim, password-reset session revocation, and verification/reset/claim web flows.
- Approved public-hosted v2 design and phased implementation plan: verified email/password accounts, optional TOTP MFA, link-only read-only providers, durable daily sync, multi-source provenance, user-controlled privacy/lifecycle, and sole-admin operations. Universal Plex history remains a feasibility-gated capability; Trakt plus manual entry is the launch fallback.
- Explicit `self_hosted` and hardened `hosted` deployment modes. Hosted mode adds one-use first-admin bootstrap, invite/provider admission controls, opaque revocable cookie sessions with CSRF, exact Host/Origin and immediate-proxy checks, encrypted Plex/Trakt credentials, provider OAuth/PIN state binding, exact Plex destination admission, event-level idempotent history sync, explicit admin reconciliation, WAL-consistent migration backups, and a separate Cloudflare Tunnel Compose topology with no published app port.
- Plex and Trakt account linking with watch-history import. Imported watches carry service provenance and immutable event identity. Normal sync is additive and never converts manual rows; placeholder correction requires explicit admin preview and selection. Hosted Plex uses PIN login plus verified resource discovery, while hosted Trakt uses OAuth; self-hosted mode retains local connection options.
- Filmography-completion trophies for a curated set of 46 marquee actors and directors (`500 + 25/film` bonus), with a new Actors tab listing per-person progress and person pages showing each filmography with watched flags. Movie pages link curated cast/directors.
- One-tap quick-log button on poster cards (search results, series grids, trending, filmographies) — log a film without opening its page.
- Home page redesigned as a dashboard: compact stat strip, continue-the-series progress, closest locked trophies, TMDB weekly trending, and the friends feed (it previously duplicated the profile page).
- `TMDB_BASE_URL`/`TRAKT_BASE_URL` overrides plus local API stubs under `server/test/stub/` for developing without real keys.

### Fixed
- Open diary editors now occupy their own history row instead of vertically centering the watch date and Remove action beside the full form on desktop.
- Content Security Policy now permits the exact Google Fonts stylesheet and font origins already used by the bundled UI.
- Movie detail routes now import the curated-person formatter they invoke, preventing a runtime 500 before diary editing.
- Plex linking on Node.js 22 now honors the DNS lookup all-address callback contract instead of failing with `ERR_INVALID_IP_ADDRESS`.
- App went blank after navigating away from the Friends or Profile ("Me") tabs: their data-loading functions were passed directly to `useEffect`, so the returned promise was treated as a cleanup function and crashed React on unmount.

### Removed
- Daily runtime cap on logging watches (26 runtime-hours per calendar day). New users typically log their entire watch history on first login, which the cap blocked with a 429.

### Changed
- Current profile streaks now use distinct qualifying, non-deleted local watch days in each user's timezone. Changing timezone transactionally re-derives historical local days from immutable UTC instants and reconciles static achievement bases without resetting profile visibility.
- Achievement progress now uses qualifying unique watches. Awards are ledger-backed and reversible: loss of basis retains a revoked trophy record with a compensating score event, while later re-qualification appends a new award generation.
- Lifetime scoring now reads from the append-oriented score ledger. Manual and imported watches are scored atomically with explicit first-watch, cooldown, and rewatch explanations; corrections use compensating reversals; watch deletion is a reversible soft delete; and provider reconciliation preserves source-event provenance.
- Acceptance/CI image updated to `noplexzone/reelscore:develop`. Stable semver tags and `latest` are reserved for future promoted releases.
- Runtime image now executes as UID 99/GID 100; bind-mounted data directories must be writable by that identity.
- Manual logging now prepares required collection and filmography bases before insertion, so metadata outages cannot commit a watch while silently missing a newly deserved trophy.
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
