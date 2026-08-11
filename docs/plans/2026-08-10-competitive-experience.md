# Competitive Experience Implementation Plan

> **For Hermes:** Execute task-by-task with TDD, a stable-commit specification review, then a quality/security review. Use the isolated worktree and Node 22 Docker commands below.

**Goal:** Add private fantasy leagues with immutable seasons, season-scoped score projections, leaderboards, and challenge bonuses without weakening lifetime diary integrity.

**Architecture:** Add schema version 9 for league, membership-episode, invite, season, and source-projection contracts. Keep lifetime and season score events in the append-oriented `score_events` table, distinguished by nullable `season_id`; derive season rows from active qualifying lifetime watch awards through an idempotent reconciliation service. Add ownership-scoped Express routes and poster-first React league pages in vertical slices.

**Tech stack:** Node.js 22, Express, better-sqlite3, Node test runner, React, Wouter, Vite, Docker/GitHub Actions.

## Global constraints

- Workspace: `/mnt/user/appdata/dev/_scratch/reelscore-competitive-experience` on branch `feat/competitive-experience`, based on `a4287f088516c0ddbacec9cd8ef43944258c106d`.
- Primary checkout `/mnt/user/appdata/dev/reelscore` and all running/named containers remain untouched.
- Use anonymous `--rm` Node 22 Docker containers for server tests and web builds. Host Node is not authoritative for `better-sqlite3`.
- Preserve Phase 1 lifetime totals, watch/achievement reconciliation, duplicate behavior, and immutable award snapshots.
- Every behavior change follows RED → GREEN → REFACTOR. Commit each task with a Conventional Commit.
- One writer owns the worktree. Reviews are read-only against immutable commits.
- No push, merge, container mutation, semver tag, or `latest` publication until Jarvis's final release gate.
- Product contract is authoritative in `docs/designs/2026-08-10-competitive-experience.md`.
- Mode contract: Casual accepts qualifying diary watches; Verified requires provider evidence; Challenge uses Casual eligibility plus challenge bonuses.

## Common verification commands

Focused server tests:

```bash
DOCKER_HOST=tcp://172.18.0.1:2375 docker run --rm -v "$PWD":/app -v /app/server/node_modules -w /app/server node:22-bookworm-slim sh -lc 'npm ci --no-audit --no-fund >/tmp/npm-ci.log && node --test <test-files>'
```

Full server suite:

```bash
DOCKER_HOST=tcp://172.18.0.1:2375 docker run --rm -v "$PWD":/app -v /app/server/node_modules -w /app/server node:22-bookworm-slim sh -lc 'npm ci --no-audit --no-fund >/tmp/npm-ci.log && npm test'
```

Web build:

```bash
DOCKER_HOST=tcp://172.18.0.1:2375 docker run --rm -v "$PWD":/app -v /app/web/node_modules -w /app/web node:22-bookworm-slim sh -lc 'npm ci --no-audit --no-fund >/tmp/npm-ci.log && npm run build -- --outDir /tmp/reelscore-phase2-dist'
```

---

### Task 1: Schema 9 league and season integrity foundation

**Objective:** Create additive tables, indexes, and database-enforced ownership invariants without changing existing totals.

**Files:**
- Modify: `server/src/db.js`
- Modify: `server/src/repositories/score-ledger.js`
- Modify: `server/test/ledger.test.js`
- Modify: `server/test/migration-v7.test.js`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces tables `leagues`, `league_memberships`, `league_invites`, `league_invite_uses`, `seasons`, and `season_members`.
- Adds nullable `effective_at`, `projection_source_event_id REFERENCES score_events(id)`, and `season_member_id REFERENCES season_members(id)` columns to `score_events`; migration converts each legacy `created_at` instant into canonical UTC `effective_at`, while additive triggers validate existing nullable `season_id` values without rebuilding the self-referential ledger table. `leagues.owner_user_id` is the sole owner authority, `season_members.username_snapshot` preserves archived standings identity, and `seasons.participants_locked_at` seals each materialized participant set.
- Produces schema version 9 and ownership/season triggers consumed by later services.

**Steps:**
1. Add failing migration tests for fresh schema 9, exact schema-8 upgrade, backup creation, idempotency, check constraints, authoritative owner identity and protected owner membership, one active membership episode per league/user, invite-use capacity, non-overlapping seasons, participant/source ownership, snapshotted participant identity, effective-time backfill/immutability, cross-user/cross-league score-event rejection, unchanged lifetime totals, and replacement of the legacy test fixture that inserts an orphan `season_id=9`.
2. Run focused migration tests and confirm they fail because schema 9 is absent.
3. Implement `migration9()`, advance `latestVersion`/default target to 9, preserve every pre-existing schema-8 column byte-for-byte, and backfill only canonical `effective_at` from each row's immutable `created_at`; reject impossible legacy instants atomically.
4. Add indexes for active membership, source-event projection uniqueness, season chronology by `effective_at`, invite lookup/use, participants, and season score chronology. Add triggers for protected owner membership/transfer target, immutable membership episodes and invite-use audit rows, non-overlapping memberships/seasons, strict calendar-valid timestamps, append-only score identity, archive-not-delete league/season/invite lifecycle, insert-forbidden pre-applied lifecycle states, irreversible cancellation/finalization with frozen standings and participant sets, immutable started-season settings, locked participant sets with one-way cutoffs, source-event user/watch consistency, and season-row participant/league consistency. Fail migration on any pre-existing non-null orphan `season_id`. League creation must insert the league and owner membership in one service transaction because SQLite has no deferred assertion for the transient circular invariant.
5. Run focused migrations, full server suite, `git diff --check`, and commit `feat(leagues): add competitive season schema`.

### Task 2: Private leagues, roles, membership episodes, and invite links

**Objective:** Let authenticated users create private leagues, manage role-scoped invites, join safely, inspect members, leave, promote members, and transfer ownership.

**Files:**
- Create: `server/src/services/league-service.js`
- Create: `server/src/routes/leagues.js`
- Create: `server/test/leagues.test.js`
- Modify: `server/src/routes/api.js`
- Modify: `server/src/index.js` only if a minimal public invite-inspection endpoint is needed outside authenticated `/api`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `createLeague(userId, input)`, `listLeagues(userId)`, `getLeague(userId, leagueId)`.
- `createInvite(actorId, leagueId, input)`, `inspectInvite(token)`, `acceptInvite(userId, token)`, `revokeInvite(actorId, inviteId)`.
- `leaveLeague`, `setMemberRole`, and `transferOwnership` with explicit transaction boundaries.
- Routes under `/api/leagues`; invite DTOs never include hashes.

**Steps:**
1. Write failing tests for owner creation, private list/read scoping (including no implicit global-admin access), role matrix, keyed token hashing, generic unknown/expired/revoked/exhausted failures, distinct-user max-use enforcement under concurrency, replay-safe acceptance, immutable rejoin episodes, leaving without score deletion, last-owner protections, ownership transfer, CSRF, strict IDs/strings, and safe DTOs.
2. Run `test/leagues.test.js` and confirm RED.
3. Implement the service with short transactions and random 256-bit invite secrets hashed with the existing keyed-token pattern. Do not log or persist plaintext tokens.
4. Add ownership-scoped routes and deterministic error/status contracts. Public invite preview is a rate-limited `POST` receiving the secret in JSON, returns only league name and expiry, sets `Cache-Control: no-store`, and is mounted before authentication. Invite links carry the secret in the URL fragment so it does not enter access logs or referrers.
5. Run focused tests, full server suite, `git diff --check`, and commit `feat(leagues): add private membership and invites`.

### Task 3: Immutable season lifecycle

**Objective:** Let league owners/admins schedule future-date seasons, snapshot participants at activation, apply departure cutoffs, and finalize non-overlapping seasons after a reconciliation grace period.

**Files:**
- Create: `server/src/services/season-service.js`
- Create: `server/test/seasons.test.js`
- Modify: `server/src/routes/leagues.js`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `createSeason(actorId, leagueId, input)`, `updateScheduledSeason`, `cancelScheduledSeason`, `materializeSeasonState`, `finalizeSeason`, `listSeasons`, `getSeason`.
- Future league-local date boundaries normalized once to UTC; immutable mode/timezone/rule/participants after start; no overlap; lifecycle `scheduled -> active -> finalizing -> finalized` with a 72-hour grace period.

**Steps:**
1. Write failing tests for DST-safe local-date boundary normalization, exact `[start,end)` behavior, future-date-only starts, overlap rejection, role authorization, mode/rule snapshot, timezone validation, scheduled-edit rules, participant snapshot (join-at-start excluded), mid-season departure cutoff, rejoin non-reactivation, lazy clock transitions, 72-hour late-import/duplicate grace, finalization irreversibility, and concurrent/replayed mutations.
2. Confirm RED in `test/seasons.test.js`.
3. Implement lifecycle validation/service and routes. Use normalized UTC instants and database transactions; derive status from immutable times plus explicit cancellation/finalization rather than trusting client status.
4. Run focused and full server tests, `git diff --check`, and commit `feat(seasons): add immutable league competitions`.

### Task 4A: Season projection engine

**Objective:** Derive idempotent season watch awards from active lifetime source events without wiring application ingress yet.

**Files:**
- Create: `server/src/services/season-scoring-service.js`
- Create: `server/test/season-scoring.test.js`
- Modify: `server/src/repositories/score-ledger.js`
- Modify: `server/package.json`

**Interfaces:**
- `reconcileSeasonScoresForUser(userId, { tmdbIds?, seasonIds? })` and bounded `reconcileSeasonBatch(seasonId, { afterUserId?, limit? })`.
- Deterministic key `season/<seasonId>/watch-event/<sourceEventId>` with explicit `projection_source_event_id` and `season_member_id`.
- Provider-evidence predicate: direct provider source or preserved merged-provider provenance for a manual canonical.

**Steps:**
1. Write failing tests for Casual/Verified/Challenge qualification, direct and merged provider proof, participant snapshots/cutoffs, exact half-open boundaries, `effective_at`, cooldown zero rows, rewatch rows, reissued lifetime sources, cross-league isolation, idempotency, and finalized freeze.
2. Implement full affected-movie desired-set reconciliation from active lifetime watch events and stored watch/provenance snapshots. Append missing source projections and compensating reversals; never edit awards or sum lifetime rows as season totals.
3. Run focused/integrity/migration/full suites and commit `feat(seasons): add season score projection engine`.

### Task 4B: Transactional reconciliation ingress and bounded repair

**Objective:** Make every competitive mutation reconcile season projections atomically and provide an auditable recovery path.

**Files:**
- Create: `server/test/season-scoring-integration.test.js`
- Modify: `server/src/services/scoring-service.js`
- Modify: `server/src/services/manual-watch-service.js`
- Modify: `server/src/services/duplicate-service.js`
- Modify: `server/src/services/duplicate-state-service.js`
- Modify: `server/src/services/user-settings-service.js`
- Modify: `server/src/services/season-service.js`
- Modify: `server/src/services/league-service.js`
- Modify: `server/src/sync.js`
- Modify: `server/src/routes/api.js` deletion path
- Modify: `server/src/routes/leagues.js`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Steps:**
1. Add rollback/idempotency tests for manual logs, provider imports including verification-only updates when `imported===0`, duplicate pending/resolution, watch deletion, timezone/eligibility recalculation, membership departure, season activation/finalization, and ownership-scoped repair.
2. Enforce finalizing ingress: after `ends_at`, accept only provider attestations received before the 72-hour deadline whose watched instant is in range, plus resolutions of duplicate cases created before `ends_at`; exclude post-end manual creation. Finalized seasons reject all repair.
3. Wire reconciliation inside the same immediate transaction as each mutation; keep external metadata calls outside write transactions. Reconcile the entire affected TMDB chronology because a late watch can reissue later lifetime awards across season boundaries.
4. Add a rate-limited owner/admin `POST /api/leagues/:leagueId/seasons/:seasonId/reconcile` accepting bounded cursor/limit input, returning the next cursor and counts, and writing actor/bounds/result audit metadata.
5. Run focused integration, duplicate, migration, and full suites; commit `feat(seasons): reconcile every competitive mutation`.

### Task 5: League shell and deterministic leaderboards

**Objective:** Provide league/season pages and weekly, monthly, seasonal, and lifetime boards with current-user inclusion.

**Files:**
- Create: `server/src/services/leaderboard-service.js`
- Create: `server/test/leaderboards.test.js`
- Modify: `server/src/routes/leagues.js`
- Create: `web/src/pages/Leagues.jsx`
- Create: `web/src/pages/League.jsx`
- Create: `web/src/pages/LeagueInvite.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/styles.css`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `getLeaderboard(userId, leagueId, { seasonId, period, cursor, limit })`.
- Rows include `rank`, `previous_rank`, `rank_change`, `points`, `distance_to_next`, `qualifying_movie_count`, member status, and snapshotted safe identity for season boards; response separately includes `current_user` when outside the page. Weekly/monthly compare to the immediately preceding clipped calendar period, seasonal to the previous finalized league season, and lifetime returns null previous rank/change.
- React pages consume `/api/leagues` contracts with no nested horizontal gesture scrolling.

**Steps:**
1. Add failing server tests for period clipping in league timezone, deterministic competition ranking/ties, rank change, pass distance, unique qualifying movie counts, departed members, pagination, ownership, and mandatory current-user inclusion.
2. Confirm RED, implement SQL/service/routes, and run focused tests.
3. Build poster-first league list/detail pages with clear active-season score/rank, compact member board, invite creation/acceptance, season controls for authorized roles, serialized mutations, and responsive vertical actions.
4. Build the web app, run server focused/full suites, `git diff --check`, and commit `feat(leagues): add competitive leaderboards`.

### Task 6A: Challenge schema, assignments, and strict rule evaluation

**Objective:** Persist auditable user-specific challenge assignments and deterministically evaluate six versioned rule families in Challenge-mode seasons only.

**Files:**
- Modify: `server/src/db.js` with additive schema 13
- Create: `server/src/services/challenge-service.js`
- Create: `server/test/challenges.test.js`
- Modify: `server/src/routes/leagues.js`
- Modify: `server/package.json`

**Rule schemas:**
- `release_year`: `{version:1,year}`; bounded integer year.
- `genre`: `{version:1,genre_name}`; normalized 1-64 character name matched against stored genres.
- `collection`: `{version:1,collection_id,required_count}`; positive ID and count 2-10 distinct films.
- `runtime`: `{version:1,minimum_minutes,maximum_minutes?}`; integer 1-1000 with ordered optional maximum.
- `recommendation`: `{version:1,tmdb_id}`; positive movie ID.
- `league_unique`: `{version:1}`; exactly one participant has an active qualifying projection for that TMDB ID.
- Definitions have integer bonus points 1-1000. Unknown/missing keys, versions, and modes are rejected.

**Steps:**
1. Add migration/service tests for ownership, Challenge-mode restriction, strict JSON validation, immutable user assignments, deterministic earliest basis, stored-metadata evaluation, and cross-league rejection.
2. Implement additive tables, validators, owner/admin assignment routes, and read DTOs without bonus events yet.
3. Run focused/migration/full tests and commit `feat(challenges): add auditable season objectives`.

### Task 6B: Challenge completion ledger and dashboard

**Objective:** Reconcile assignment completion and append/reverse season bonus events, then expose progress in the league UI.

**Files:**
- Modify: `server/src/services/challenge-service.js`
- Modify: `server/src/services/season-scoring-service.js`
- Modify: `server/src/routes/leagues.js`
- Modify: `server/test/challenges.test.js`
- Modify: `web/src/pages/League.jsx`
- Modify: `web/src/styles.css`
- Modify: `CHANGELOG.md`

**Steps:**
1. Test one active completion per assignment/basis generation, deterministic reactivation, rollback, basis deletion, finalization freeze, and league-unique revocation when a second member qualifies.
2. Append `challenge_bonus` rows with deterministic assignment-generation keys and compensating reversals; never edit score rows.
3. Add responsive challenge cards showing rule, progress, points, completion basis, and season status without blocking watch logging.
4. Run focused/full tests and web build; commit `feat(challenges): score season bonus objectives`.

### Task 7: Integration, documentation, and acceptance artifact

**Objective:** Freeze, review, publish, and smoke the complete Phase 2 candidate.

**Files:**
- Modify: `README.md`
- Modify: `docs/SCORING.md`
- Modify: `docs/architecture/competitive-integrity.md`
- Modify: `docs/BACKUP_RESTORE.md` if schema verification changes
- Modify: `CHANGELOG.md`
- Modify: `/mnt/user/appdata/dev/CONTAINERS.md` only after the published digest changes

**Steps:**
1. Add exact league/mode/season/leaderboard/challenge and recovery documentation. Remove stale roadmap language.
2. Run focused migration/season/challenge suites, full Node 22 server tests, web build, both high-severity audits, `git diff --check`, and production-image fresh/restore smoke.
3. Run independent whole-branch specification review, then quality/security/data-integrity review. Remediate and re-review all blocking findings.
4. After authorization, push the branch, open a PR, wait for exact-head CI, merge only after approval, wait for exact-merge CI/publication, verify `noplexzone/reelscore:develop` digest and provenance, pull by digest, and repeat fresh/restore HTTP smoke.
5. Update the container manifest with the verified digest and report the literal digest-pinned pull line. Do not publish semver or `latest`.
