# Curated Starter Canon Achievement Implementation Plan

> **For Hermes:** Use subagent-driven-development or direct bounded implementation task-by-task; retain Jarvis review and release authority.

**Goal:** Add one versioned ReelScore-curated 25-film Starter Canon with poster-first progress browsing and a single 875-point completion trophy.

**Architecture:** A source-controlled catalog is the immutable editorial and scoring basis; it contains a stable slug/version, fixed TMDB IDs, display metadata, and award definition. Achievement reconciliation derives progress only from distinct, active watches with `qualifies_for_achievement=1`, so imported/unverified watches remain non-competitive. Authenticated read APIs expose list summaries/details, and dedicated responsive pages present progress without requiring live TMDB calls.

**Tech Stack:** Node.js 22, Express, better-sqlite3, React 18, Wouter, Node test runner, Docker, Playwright, Impeccable.

## Global Constraints

- Worktree: `/mnt/user/appdata/dev/_scratch/reelscore-curated-achievements`.
- Branch: `feat/curated-list-achievements`, based on merged `origin/main` commit `1555da1`.
- Pilot name: `ReelScore Starter Canon`.
- Pilot membership is exactly 25 approved films and is immutable as version `v1`.
- Award exactly one completion trophy worth **875 points**; there are no partial-point milestones.
- Trophy key: `curated-list:starter-canon:v1`.
- Only distinct, active rows with `qualifies_for_achievement=1` count.
- Letterboxd/unverified imports, deleted watches, cooldown rewatches, duplicate candidates, and otherwise ineligible rows must not advance progress or award points.
- Losing a qualifying basis revokes the active award exactly once; regaining it creates one new award generation, following existing achievement-ledger semantics.
- The catalog must not depend on live TMDB availability for scoring or routine page rendering.
- Preserve existing ReelScore ticket/stub visual identity; list browsing is a poster-first Operate surface.
- Support loading, error, empty/impossible, completed, long-title, desktop, and mobile states with accessible links and progress semantics.
- Do not update or restart the primary `reelscore` container without Caleb's explicit approval.
- Do not publish `latest` or create a stable version/tag.

## Approved `starter-canon:v1` Membership

| Order | TMDB ID | Display title | TMDB year |
| ---: | ---: | --- | ---: |
| 1 | 19 | Metropolis | 1927 |
| 2 | 901 | City Lights | 1931 |
| 3 | 630 | The Wizard of Oz | 1939 |
| 4 | 15 | Citizen Kane | 1941 |
| 5 | 289 | Casablanca | 1943 |
| 6 | 872 | Singin' in the Rain | 1952 |
| 7 | 346 | Seven Samurai | 1954 |
| 8 | 389 | 12 Angry Men | 1957 |
| 9 | 539 | Psycho | 1960 |
| 10 | 62 | 2001: A Space Odyssey | 1968 |
| 11 | 238 | The Godfather | 1972 |
| 12 | 578 | Jaws | 1975 |
| 13 | 44012 | Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles | 1976 |
| 14 | 11 | Star Wars | 1977 |
| 15 | 348 | Alien | 1979 |
| 16 | 85 | Raiders of the Lost Ark | 1981 |
| 17 | 78 | Blade Runner | 1982 |
| 18 | 925 | Do the Right Thing | 1989 |
| 19 | 329 | Jurassic Park | 1993 |
| 20 | 680 | Pulp Fiction | 1994 |
| 21 | 129 | Spirited Away | 2001 |
| 22 | 120 | The Lord of the Rings: The Fellowship of the Ring | 2001 |
| 23 | 598 | City of God | 2002 |
| 24 | 376867 | Moonlight | 2016 |
| 25 | 496243 | Parasite | 2019 |

---

### Task 1: Add the immutable catalog and competitive reconciliation

**Objective:** Make the approved list a deterministic static achievement basis with existing reversible-ledger behavior.

**Files:**
- Create: `server/src/curated-lists.js`
- Modify: `server/src/services/achievement-service.js`
- Modify: `server/src/achievements.js`
- Test: `server/test/achievements-eligibility.test.js`
- Test: `server/test/season-scoring-integration.test.js`

**Interfaces:**
- Produce `CURATED_LISTS`, `curatedList(slug)`, and DTO-safe frozen catalog records.
- Extend `qualifyingFacts()`/static rules with distinct eligible membership progress.
- Extend `achievementProgress(userId)` with `curated_lists`, each containing slug/version/count/total/complete.

**Steps:**
1. Write RED tests proving 24 eligible films do not award, the 25th awards exactly 875, excluded/imported/deleted/duplicate rows do not count, repeated reconciliation is idempotent, deletion reverses once, and requalification creates exactly one new generation.
2. Run the focused achievement and season-integration tests under `node:22-bookworm-slim`; verify failures are specifically missing curated-list behavior.
3. Add the frozen v1 catalog and static reconciliation rule with metadata containing list slug/version and the exact required/qualifying TMDB IDs.
4. Keep all ledger writes inside the existing prepared reconciliation transaction; do not add a parallel scoring path.
5. Run focused tests GREEN, then review the diff for cross-user, duplicate-ID, mutation, and imported-watch leakage.
6. Commit as `feat(achievements): add Starter Canon scoring` after review PASS.

### Task 2: Expose owner-scoped list progress APIs

**Objective:** Provide authenticated summary and detail DTOs without live provider dependencies or private-data leakage.

**Files:**
- Create: `server/src/services/curated-list-service.js`
- Modify: `server/src/routes/api.js`
- Test: `server/test/movie-http.test.js` or create `server/test/curated-lists-http.test.js`

**Interfaces:**
- `GET /api/curated-lists` returns catalog summary plus owner progress.
- `GET /api/curated-lists/:slug` returns ordered film records with `watched` derived only from qualifying active owner rows.
- Unknown slugs return 404; anonymous requests retain normal auth behavior.

**Steps:**
1. Write RED HTTP tests for unauthenticated access, valid summary/detail DTOs, exact ordering, owner isolation, unknown slug, completion state, and non-qualifying imported rows.
2. Implement one service that joins immutable catalog membership to an owner-scoped eligible watch-ID set.
3. Ensure responses contain no raw watch rows, notes, import provenance internals, or other-user state.
4. Run focused HTTP and achievement tests GREEN and syntax checks.
5. Commit as `feat(lists): expose curated progress API` after review PASS.

### Task 3: Build the poster-first Starter Canon experience

**Objective:** Let users discover the list, understand the 875-point completion condition, and inspect watched/unwatched progress on desktop and mobile.

**Files:**
- Create: `web/src/pages/CuratedLists.jsx`
- Create: `web/src/pages/CuratedList.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/pages/Achievements.jsx`
- Modify: `web/src/styles.css`
- Test: create `web/test/curated-lists.test.js`

**Interfaces:**
- Add authenticated routes `/lists` and `/lists/:slug`.
- Add a `Lists` navigation entry.
- Achievements links the locked or earned Starter Canon trophy to its progress page.
- Film cards link to existing `/movie/:tmdbId` routes and use existing poster/fallback conventions.

**Steps:**
1. Write RED frontend contract/helper tests for routing, progress copy, links, completion state, and safe percent calculation.
2. Implement summary and detail pages with explicit `watched/25`, progressbar semantics, `+875 PTS`, completion state, ordered poster grid, and accessible watched indicators.
3. Keep loading/error/empty states in the page; never present failed API data as zero progress.
4. Add responsive styles using incumbent tokens/components; avoid nested cards and horizontal overflow.
5. Run web tests, production build, high audit, and `impeccable detect web/src/`.
6. Run disposable published-shape browser acceptance at desktop and mobile widths, checking navigation, list/detail/movie links, completion rendering, console errors, failed requests, and overflow.
7. Commit as `feat(lists): add Starter Canon progress UI` after review PASS.

### Task 4: Documentation, whole-branch review, and acceptance handoff

**Objective:** Make the milestone truthful, reviewed, and reproducible without deploying the primary container.

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/plans/2026-08-30-phase3-retention-social.md`

**Steps:**
1. Document the fixed v1 membership model, exact 875-point completion rule, eligible-watch boundary, and list routes under `Unreleased`.
2. Run full server and web suites, builds, audits, syntax/diff/secret checks, Docker build, fresh-state migration/health/API/browser smoke, and Impeccable detector.
3. Obtain whole-branch Critical/Important review; remediate as one bounded wave and re-review.
4. Commit documentation as part of the nearest coherent task or `docs(achievements): document Starter Canon`.
5. Push and open a PR only after local review passes; require green CI before requesting merge approval.
6. After approved merge, verify `noplexzone/reelscore:develop` digest and linux/amd64 manifest, smoke the exact digest on disposable data, and provide the literal pull line.
7. Do not update the primary container until Caleb explicitly approves deployment.
