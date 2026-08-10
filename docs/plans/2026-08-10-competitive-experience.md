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
- Modify: `server/test/migration.test.js`
- Modify: `server/test/migration-v7.test.js`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces tables `leagues`, `league_memberships`, `league_invites`, `league_invite_uses`, `seasons`, and `season_members`.
- Adds nullable `projection_source_event_id REFERENCES score_events(id)` and `season_member_id REFERENCES season_members(id)` columns to `score_events`; additive triggers validate existing nullable `season_id` values without rebuilding the self-referential ledger table.
- Produces schema version 9 and ownership/season triggers consumed by later services.

**Steps:**
1. Add failing migration tests for fresh schema 9, exact schema-8 upgrade, backup creation, idempotency, check constraints, one active membership episode and owner per league/user, invite-use capacity, non-overlapping seasons, participant/source ownership, cross-user/cross-league score-event rejection, unchanged lifetime totals, and replacement of the legacy test fixture that inserts an orphan `season_id=9`.
2. Run focused migration tests and confirm they fail because schema 9 is absent.
3. Implement `migration9()`, advance `latestVersion`/default target to 9, and preserve all schema-8 rows byte-for-byte except the additive nullable column.
4. Add indexes for active membership/owner, season chronology, invite lookup/use, participants, and season score chronology. Add triggers for owner membership, non-overlapping membership episodes/seasons, season ownership, immutable started-season settings, source-event user/watch consistency, and season-row participant/league consistency. Fail migration on any pre-existing non-null orphan `season_id` rather than rewriting it.
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
4. Add ownership-scoped routes and deterministic error/status contracts. Public invite preview is a rate-limited `POST` receiving the secret in JSON, returns only league name/owner/default mode/approximate size/expiry, sets `Cache-Control: no-store`, and is mounted before authentication. Invite links carry the secret in the URL fragment so it does not enter access logs or referrers.
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

### Task 4: Season-scoped watch projection and reconciliation

**Objective:** Project qualifying active lifetime watch awards into every eligible season and reverse projections whenever their basis disappears.

**Files:**
- Create: `server/src/services/season-scoring-service.js`
- Create: `server/test/season-scoring.test.js`
- Modify: `server/src/services/scoring-service.js`
- Modify: `server/src/services/manual-watch-service.js`
- Modify: `server/src/services/duplicate-service.js`
- Modify: `server/src/services/duplicate-state-service.js` only where its transaction must call the projector
- Modify: `server/src/sync.js`
- Modify: `server/src/routes/api.js` deletion path
- Modify: `server/src/repositories/score-ledger.js`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `reconcileSeasonScoresForUser(userId, { watchIds?, seasonIds? })` and bounded `reconcileSeason(seasonId)`.
- Deterministic generation key `season/<seasonId>/watch/<watchId>/<generation>` with explicit `projection_source_event_id` and `season_member_id` references.
- Provider-evidence predicate: direct provider source or active merged provider provenance for a manual canonical.

**Steps:**
1. Write failing tests covering Casual/Verified/Challenge mode qualification, direct provider proof, preserved merged-provider proof, immutable provider evidence after disconnect, participant snapshots/cutoffs, exact season boundaries, late imports during finalizing, finalized freeze, cooldown zero rows, rewatch rows, deletion, duplicate pending/resolution, timezone changes, reissued lifetime awards across boundaries, verification-only provider updates when `imported===0`, overlapping seasons in different leagues, idempotent retries, source-event conflicts, and transaction rollback.
2. Confirm RED in the focused season-scoring suite.
3. Implement desired-set reconciliation for the entire affected movie chronology using only active lifetime watch events, season participants, and stored watch/provenance snapshots. Append missing rows; reverse undesired rows before finalization; never edit an award or sum lifetime rows for a season. User timezone changes never move season membership.
4. Wire reconciliation into existing competitive mutation transactions. Keep external metadata fetches outside write transactions.
5. Run focused tests, all integrity/duplicate/migration tests, full suite, `git diff --check`, and commit `feat(seasons): project qualifying watch awards`.

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
- Rows include `rank`, `previous_rank`, `rank_change`, `points`, `distance_to_next`, `qualifying_movie_count`, member status, and safe user identity; response separately includes `current_user` when outside the page.
- React pages consume `/api/leagues` contracts with no nested horizontal gesture scrolling.

**Steps:**
1. Add failing server tests for period clipping in league timezone, deterministic competition ranking/ties, rank change, pass distance, unique qualifying movie counts, departed members, pagination, ownership, and mandatory current-user inclusion.
2. Confirm RED, implement SQL/service/routes, and run focused tests.
3. Build poster-first league list/detail pages with clear active-season score/rank, compact member board, invite creation/acceptance, season controls for authorized roles, serialized mutations, and responsive vertical actions.
4. Build the web app, run server focused/full suites, `git diff --check`, and commit `feat(leagues): add competitive leaderboards`.

### Task 6: Challenge assignments, completion, and bonuses

**Objective:** Add auditable season challenge definitions and append-oriented bonus scoring for the six initial rule families.

**Files:**
- Modify: `server/src/db.js` with schema 10 only if challenge tables are intentionally separated from schema 9 after Task 1 review
- Create: `server/src/services/challenge-service.js`
- Create: `server/test/challenges.test.js`
- Modify: `server/src/routes/leagues.js`
- Modify: `server/src/services/season-scoring-service.js`
- Modify: `web/src/pages/League.jsx`
- Modify: `web/src/styles.css`
- Modify: `server/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Challenge rule snapshots for `release_year`, `genre`, `collection`, `runtime`, `recommendation`, and `league_unique`.
- Assignment/completion records link league, season, user, basis watch, and active `challenge_bonus` score event.

**Steps:**
1. Write failing schema/service tests for strict rule validation, role permissions, assignment ownership, stored-metadata evaluation, one completion per assignment/basis generation, league-unique revocation when uniqueness is lost, rollback, and idempotent bonus reversal/reactivation.
2. Confirm RED; add additive migration if required and implement challenge reconciliation.
3. Add dashboard challenge cards showing rule, progress, points, completion basis, and season status without slowing watch logging.
4. Run focused/full tests and web build, then commit `feat(challenges): add season bonus objectives`.

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
