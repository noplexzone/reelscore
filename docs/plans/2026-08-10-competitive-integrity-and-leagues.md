# Competitive Integrity and Leagues Implementation Plan

> **For Hermes:** Execute task-by-task with TDD, specification review, quality review, and fresh verification.

**Goal:** Evolve ReelScore into “a private movie diary combined with a fantasy league for watching movies,” establishing explainable, reversible, timezone-correct scoring before seasons or social expansion.

**Architecture:** `watches` remains the immutable event history. Explicit, versioned eligibility fields decide competitive use; an append-oriented `score_events` ledger is the score source of truth. Dedicated services own scoring, achievements, streaks, duplicates, and later leagues; routes validate and orchestrate. Lifetime ledger rows use `season_id IS NULL`; seasonal awards are separate rows.

**Tech Stack:** Node 22, Express 4, better-sqlite3/SQLite WAL, React 18, Vite 8, Node test runner; Playwright added in Phase 4.

## Global Constraints

- Preserve current users, watch history, achievements, and exact pre-migration lifetime totals.
- Do not begin leagues/social features until qualifying watches, ledger, timezone streaks, duplicates, and regressions are stable.
- Migrations are additive, idempotent, backup-gated, and legacy-fixture tested.
- Backfill from stored `watches.points`/`achievements.points`; never re-fetch TMDB during migration.
- New score metadata snapshots rating/runtime inputs so provider changes cannot alter old awards.
- Reverse points with `score_events.reversed_at`; never delete or overwrite awarded ledger rows.
- Watch deletion becomes soft deletion (`deleted_at`) so history stays auditable.
- Use RED → GREEN → REFACTOR for behavior changes; update `CHANGELOG.md` under `Unreleased`.
- Acceptance remains `noplexzone/reelscore:develop`; no semver or `latest` without separate approval.
- Do not modify/restart a running ReelScore container; none is currently recorded as deployed.

## Business Rules

### Qualifying watches

- `qualifies_for_volume`: canonical first non-deleted watch of a movie per user only.
- `qualifies_for_achievement`: canonical unique-film progress only. Rewatches, cooldown events, and unresolved duplicate candidates do not advance unique progress.
- `qualifies_for_streak`: canonical watches and rewatches outside the 30-day cooldown. Cooldown/pending duplicates do not extend streaks.
- `qualifies_for_season`: events eligible for a watch/rewatch score under the active rule. Cooldown/pending duplicates are excluded.
- Outside-cooldown rewatches use ledger category `watch_rewatch`; cooldown events remain history with no active award.
- Provider identity remains idempotent on `(user_id, provider_service, provider_connection_id, provider_event_id)`.

### Duplicate review

- Plausible manual/provider or cross-provider matches create `duplicate_cases`. The established canonical event remains qualifying; the candidate stays non-qualifying while pending.
- `merge`: retain both immutable events, point both to one logical canonical event, keep candidate awards reversed.
- `keep_both` / `keep_separate`: retain both and reconcile the candidate as a rewatch subject to cooldown.
- `ignore_future_matching`: keep separate and add a user/movie/source-pair ignore rule.
- Pending cases never increase competitive progress.

### Achievements and time

- Achievement awards have active/revoked state. Losing the only qualifying basis reverses its ledger award and sets `revoked_at`; re-qualification creates a new score event.
- Canonical time fields are `watched_at_utc`, `watched_day_local`, and `timezone_used`.
- Existing data backfills as UTC. Imports preserve their instant and derive local day using the user timezone at import.
- Timezone changes affect future events only; historical reinterpretation is separate future work.

## Current Conflicts

- `totalScore()` sums mutable watch and achievement point columns; no explanations or reversal history.
- `sync.recomputeUserWatchScores()` rewrites old watch points after imports/deletes.
- Volume/progress uses `COUNT(*)`; other rules inconsistently use `DISTINCT tmdb_id`.
- Achievements are permanent point-bearing rows, conflicting with reversible competitive totals.
- `currentStreak()` uses UTC dates and fixed 86,400,000 ms intervals.
- DELETE physically removes watch events.
- Provider event idempotency is strong, but additive manual/provider history can create unresolved competitive duplicates.
- README authentication, provider merge behavior, architecture, and roadmap are stale.

---

## Phase 1 — Competitive Integrity Foundation

### Task 1: Architecture record and migration 7

**Files:** create `docs/architecture/competitive-integrity.md`, `server/src/time.js`, `server/src/eligibility.js`, `server/test/time.test.js`, `server/test/eligibility.test.js`; modify `server/src/db.js`, `server/test/migration.test.js`, `server/package.json`, `CHANGELOG.md`.

**Schema:**
- `users.timezone TEXT NOT NULL DEFAULT 'UTC'`
- `watches.watched_at_utc`, `watched_day_local`, `timezone_used`, four eligibility flags, `eligibility_rule_version`, `eligibility_reason`, `deleted_at`, and logical-canonical reference
- `score_events(id,user_id,watch_id,achievement_id,season_id,category,points,rule_version,metadata_json,created_at,reversed_at)` plus indexes/FKs
- `achievements.score_event_id`, `achievements.revoked_at`
- `duplicate_cases`, `duplicate_ignore_rules`

**Backfill:** normalize legacy timestamps as UTC; calculate canonical chronology without TMDB; insert one `legacy-v1` ledger event for each non-zero stored watch/achievement award; preserve exact totals; remain idempotent.

**Proof:** upgrade/idempotency/FK/index/total-preservation tests; IANA validation; midnight/DST conversion; eligibility matrix.

**Commit:** `feat(scoring): add qualifying-watch and ledger schema`

### Task 2: Authoritative ledger and score reconciliation

**Files:** create `server/src/services/scoring-service.js`, `server/src/repositories/watch-repository.js`, `server/test/ledger.test.js`; modify `server/src/scoring.js`, `server/src/db.js`, `server/src/routes/api.js`, `server/src/sync.js`, scoring/sync tests.

**Interfaces:** `awardScoreEvent`, `reverseScoreEvents`, `reconcileMovieEligibility`, `scoreWatchEvent`, and `totalScore(userId,{seasonId:null})`.

**Rules:** idempotent first-watch awards; metadata explains title/TMDB id/rating/runtime/calculation/reason; backdated events may reverse/reassign canonical awards using stored metadata; deletion/reconciliation only reverses or appends; API exposes breakdown.

**Proof:** first/cooldown/rewatch category, import idempotency, no duplicate first award, delete-only-qualifying reversal, backdated reconciliation, TMDB-change stability, lifetime/season separation.

**Commit:** `feat(scoring): make score ledger authoritative`

### Task 3: Achievement eligibility and ledger awards

**Files:** create `server/src/services/achievement-service.js`, `server/test/achievements-eligibility.test.js`; reduce `server/src/achievements.js` to catalog/compatibility facade; modify API/sync integration.

Volume, genre, decade, series, and filmography queries use `qualifies_for_achievement=1 AND deleted_at IS NULL`. Streak awards use eligible local days. Unlock/reactivation appends an achievement score event; loss of basis reverses it.

**Proof:** duplicate-volume, zero-point uniqueness, delete/revoke/reactivate, and imported duplicate regressions.

**Commit:** `feat(achievements): base progress on qualifying watches`

### Task 4: User timezone and local-day streaks

**Files:** create `server/src/services/streak-service.js`, `server/test/streak.test.js`; modify `server/src/routes/api.js`, `server/src/db.js`, `web/src/pages/Profile.jsx` and API helpers as needed.

**Interfaces:** `localDay(utcInstant,timeZone)`, `currentStreak(userId,{asOf})`; settings endpoint validates/persists timezone without resetting `public_profile`.

**Proof:** midnight, America/Chicago DST changes, different-zone users, invalid-zone rejection, imported timestamp preservation.

**Commit:** `feat(time): calculate streaks by user timezone`

### Task 5: Duplicate review API and UI

**Files:** create `server/src/services/duplicate-service.js`, `server/src/routes/duplicates.js`, `server/test/duplicates.test.js`, `web/src/pages/Duplicates.jsx`; modify sync, API registration, app navigation, and styles.

**Routes:** `GET /api/duplicates?status=pending`; `POST /api/duplicates/:id/resolve` with `merge|keep_both|keep_separate|ignore_future_matching`.

**Proof:** pending candidate is non-qualifying; every resolution is idempotent; ownership enforced; ignore rules scoped; totals/achievements reconcile.

**Commit:** `feat(sync): add duplicate review workflow`

### Task 6: Integration, documentation, acceptance artifact

Update README, CHANGELOG, scoring/architecture docs, provider-sync behavior, and tested backup/restore instructions. Run Node 22 server tests, web build, both high-severity audits, fresh/legacy migration smoke tests, independent specification and quality reviews, CI, Docker Hub digest verification, and fresh-container HTTP smoke. Report literal pull line only after all gates pass.

## Phase 2 — Competitive Experience (blocked by Phase 1)

1. Add `leagues`, `league_members`, invite links, and `seasons`; private roles; Casual/Verified/Challenge modes.
2. Project qualifying events into separate season-scoped ledger rows. Never calculate seasons by summing lifetime rows.
3. Add weekly/monthly/seasonal/lifetime leaderboards with rank, rank change, distance, qualifying movie count, and mandatory current-user inclusion.
4. Add challenge definitions, assignments, completion state, dashboards, and `challenge_bonus` score events. Initial rules: release year, genres, collection/trilogy, runtime, recommendation, league-unique film.

## Phase 3 — Retention and Social

1. Optional rating/review/notes/favorite/tags/watch-date/venue/visibility fields without slowing one-tap logging; date edits are audited and trigger reconciliation.
2. Shareable friend invites, outgoing/cancel/remove/block, and league invitations.
3. Competition-first dashboard: current rank, pass distance, challenge, season end, league activity; trending secondary.

## Phase 4 — Technical Quality and Documentation

1. Complete route/service/repository separation and introduce shared validated schemas/API docs after a compatibility spike.
2. TMDB timeout, bounded retry, `Retry-After`, request deduplication, persistent cache, and bounded import concurrency.
3. Frontend tests, Playwright, accessibility checks, loading/error states, abortable search, and no nested interactive controls/silent API failures.
4. Truth-pass authentication, sync, roadmap, architecture, screenshots, demos, privacy, scoring, and backup/restore docs.

## Final Acceptance Matrix

- Duplicates cannot inflate achievements or first-watch scores.
- Deleting the only qualifying watch reverses active competitive awards.
- Cooldown and rewatch category work.
- Provider sync stays idempotent; manual/import rules match documentation.
- TMDB changes do not alter historical awards.
- Old watches do not affect new seasons; boundaries/rankings are exact.
- Streaks pass timezone, DST, midnight, and cross-zone cases.
- Migrations preserve all legacy data and exact pre-migration totals after verified backup.
