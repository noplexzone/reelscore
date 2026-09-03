# Letterboxd Diary Import Implementation Plan

> **For Hermes:** Use the claude-code skill when authenticated; otherwise use one isolated implementation worker per task and retain Jarvis review/release authority.

**Goal:** Import official Letterboxd `diary.csv` and `watched.csv` exports into ReelScore as private, auditable diary history without allowing user-authored CSV to alter competitive scores, streaks, achievements, duplicates, or seasons.

**Architecture:** Use a two-stage preview/commit flow. Parsing and bounded TMDB resolution happen before mutation; commit inserts source-keyed, unverified watches in one immediate transaction. A schema-level eligibility firewall ensures imported rows remain zero-point and never advance eligible chronology. The Settings UI exposes explicit row errors and candidate choices before commit.

**Tech stack:** Node.js 22, Express, better-sqlite3, React 18/Vite, Node test runner, Playwright acceptance, Docker.

## Global Constraints

- Work only in `/mnt/user/appdata/dev/_scratch/reelscore-letterboxd-import` on `feat/letterboxd-import`.
- Preserve competitive fairness and data integrity before convenience.
- Letterboxd CSV is user-supplied and therefore **private, unverified, and non-competitive**. It must not affect lifetime points, Casual/Verified/Challenge seasons, streaks, achievements, duplicate review, or eligible first-watch/rewatch chronology.
- Do not forge Plex/Trakt provider identity or reuse provider-specific `importHistory()`.
- Do not fetch Letterboxd URLs. Resolve titles through TMDB only, with bounded concurrency of four and no network inside write transactions.
- Keep global JSON parsing at 64 KiB. Multipart limits: at most two files, only `diary.csv` and/or `watched.csv`, maximum 2 MiB each and 10,000 combined rows.
- Exact supported headers:
  - `diary.csv`: `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date`
  - `watched.csv`: `Date,Name,Year,Letterboxd URI`
- `diary.csv` chronology uses `Watched Date`; `watched.csv` Date is only a “marked watched” date. Convert calendar days to deterministic local noon in the owner’s IANA timezone while preserving source day/kind.
- Imports default to `visibility='private'`, `points=0`, and all `qualifies_for_*` flags false.
- Primary ReelScore container must remain untouched until acceptance passes and Caleb explicitly approves deployment.
- Update `CHANGELOG.md` under `Unreleased`; no stable tag or `latest` publication.

---

### Task 1: Schema 15 and eligibility firewall

**Objective:** Make non-competitive import status durable and impossible to bypass through repositories, direct SQL, scoring, or ledger writers.

**Files:**
- Modify: `server/src/db.js`
- Modify: `server/src/eligibility.js`
- Modify: `server/src/repositories/watch-repository.js`
- Modify: `server/src/repositories/score-ledger.js`
- Create: `server/test/migration-v15.test.js`
- Create or modify: `server/test/eligibility.test.js`, `server/test/ledger.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Produces watch columns: `competition_eligibility`, `source_recorded_date`, `source_date_kind`, `import_source`, `import_event_key`.
- Produces import tables `letterboxd_import_jobs` and `letterboxd_import_rows` with owner-scoped public job IDs, SHA-256 file digests, hashed one-use commit tokens, states, decision hashes, bounded counts, expiry/timestamps, row snapshots, resolution state, candidate JSON, selected TMDB ID, watch ID, and error.
- Produces partial unique watch index `(user_id, import_source, import_event_key)` where import identity is non-null.

**TDD steps:**
1. Add exact schema-14→15 migration tests using the real migration chain. Preserve all old watch columns byte-for-byte and verify defaults on old rows.
2. Add direct-SQL negative tests proving `unverified_import` requires zero points, every eligibility flag false, private visibility, no provider tuple, and non-empty import identity/date provenance.
3. Add ledger-boundary test rejecting a new root watch score event for an unverified watch.
4. Add chronology test: an old unverified import before a legitimate manual/provider watch neither becomes canonical nor turns the legitimate event into a rewatch.
5. Implement migration 15, bump latest/target version everywhere, triggers/indexes/tables, repository validation, and eligibility reason `unverified_import`.
6. Run targeted tests, then the full server suite in Node 22 Docker. Verify `integrity_check`, `foreign_key_check`, forced rollback, and idempotent migration rerun.
7. Commit: `feat(import): add unverified diary integrity foundation`.

### Task 2: Strict CSV parser and preview/commit service

**Objective:** Parse official exports, resolve movies safely, preview every decision, and commit atomically/idempotently.

**Files:**
- Create: `server/src/imports/letterboxd-csv.js`
- Create: `server/src/services/letterboxd-import-service.js`
- Create: `server/src/routes/imports.js`
- Modify: `server/src/routes/api.js`
- Modify: `server/src/tmdb.js`
- Modify: `server/package.json` and lockfile only for one maintained streaming multipart dependency if justified
- Create: `server/test/letterboxd-csv.test.js`
- Create: `server/test/letterboxd-import.test.js`
- Create: `server/test/letterboxd-import-http.test.js`
- Modify: `server/test/stub/tmdb-stub.js`

**Interfaces:**
- `parseLetterboxdCsv(buffer, expectedKind)` returns normalized rows or bounded row errors.
- `previewLetterboxdImport(userId, files, deps)` returns job ID, one-use token, counts, rows, and bounded candidates.
- `commitLetterboxdImport(userId, publicJobId, input, deps)` consumes explicit choices/skips and returns an immutable stored result.
- Routes: `POST /api/imports/letterboxd/preview`, `GET /api/imports/letterboxd/:jobId`, `POST /api/imports/letterboxd/:jobId/commit`.

**Parser contract:**
- Accept strict UTF-8 with optional BOM, CRLF/LF, and RFC-4180 quoted commas/newlines/doubled quotes.
- Reject malformed UTF-8/CSV, duplicate or reordered/extra/missing headers, NUL bytes, excess file/row limits, impossible calendar dates, invalid URI host/scheme, empty/oversize names, and invalid four-digit years.
- Rating blank→null; otherwise only half-steps `0.5…5.0`, converted exactly to integer `10…100`.
- Rewatch only blank or `Yes`; provenance only, never derived `is_rewatch`.
- Tags: split decoded Tags field on commas, trim/lowercase/dedupe/sort, then enforce existing 20×30 and `[a-z0-9 _-]` contract; invalid tags are row errors.
- Stable keys: diary `diary:<normalized-uri>:<watched-date>:<occurrence>`; watched `watched:<normalized-uri>`.

**Resolution/transaction contract:**
1. Group by normalized `(title, year)` and search TMDB with `primary_release_year`, concurrency ≤4.
2. Auto-select only one exact normalized title/original-title and release-year match; otherwise require explicit choice or skip.
3. Never fetch Letterboxd URI. Bound pagination and candidate DTO size.
4. Before mutation, fetch/validate selected movie details with concurrency ≤4.
5. In one immediate transaction: recheck owner/job/token/expiry/decision hash; CAS preview→committing; insert diary rows first; insert watched placeholders only when no diary/existing active watch covers the film; link every row to inserted/existing/skipped/error; store immutable result; consume token.
6. Do not invoke scoring, season, duplicate, streak, or achievement reconciliation.
7. Identical completed replay returns stored result; changed decisions/token conflict; concurrent commit converges via CAS and source-key uniqueness.

**TDD steps:**
1. RED parser matrix: BOM, CRLF, quotes/newlines, exact headers, invalid UTF-8, dates, ratings, tags, URI/year/name bounds.
2. RED service matrix: unique/ambiguous/missing matches, max concurrency four, no Letterboxd fetch, preview read-only, diary-first overlap, retries, changed export, concurrent commit, TMDB outage pre-transaction, late abort rollback then retry.
3. RED HTTP matrix: auth, CSRF, owner isolation, strict multipart names/types/count/size/truncation, expired/replayed token, safe errors.
4. Implement minimal parser/service/routes and extend TMDB search year support.
5. Run targeted and full Node 22 Docker suite, audits, migration checks, and review.
6. Commit: `feat(import): add Letterboxd preview and commit API`.

### Task 3: Settings import UI and browser acceptance

**Objective:** Let an owner upload, review, resolve, and commit an import without implying imported rows are competitive evidence.

**Files:**
- Create: `web/src/components/LetterboxdImport.jsx`
- Modify: `web/src/pages/Settings.jsx`
- Modify: `web/src/pages/Movie.jsx`
- Modify: `web/src/styles.css`
- Add focused frontend utility/component tests under `web/test/`
- Add Playwright acceptance under `web/e2e/` only if CI/runtime isolation is implemented correctly
- Modify: `CHANGELOG.md`, `README.md`, and the Phase 3 roadmap

**UI contract:**
- Two named file inputs, preview, summary/error counts, paged row review, accessible candidate selectors and skip controls, explicit warning: “Imported Letterboxd history is private and does not affect competitive scores or achievements.”
- Commit disabled until every unresolved row has an explicit choice or skip.
- Show rating/tags, row errors, already-imported outcomes, and honest `Marked watched` wording for watched-only rows.
- Never expose private notes or raw internal tokens.

**TDD/verification steps:**
1. Add failing tests for decision completeness, FormData contract, invalid-row accessibility, replay result, and marked-watched wording.
2. Implement the smallest Settings card and Movie history labeling.
3. Run web tests/build/audit and `npx --yes impeccable detect web/src/`.
4. Run desktop/mobile Playwright against a disposable schema-15 image: upload→preview→resolve→commit→reload; duplicate submit; score/streak/season/achievement values unchanged; no console/network failures; no horizontal overflow.
5. Run independent specification and integrity review, then full server/web gates.
6. Commit: `feat(import): add Letterboxd diary workflow`.

## Integration and handoff

1. Whole-branch review with every Critical/Important finding resolved.
2. Push feature branch and open PR; require green CI.
3. Merge only after green CI; verify merged SHA.
4. Wait for `noplexzone/reelscore:develop`, verify top-level registry digest and linux/amd64 manifest.
5. Fresh disposable schema-15 runtime/migration/API/browser smoke against the pulled image.
6. Report the literal pull line. Do not update the primary container until Caleb explicitly approves it.
7. Only after import acceptance, start curated-list achievements. Hosted/freemium remains later and must not gate private diary integrity.
