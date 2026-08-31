# Phase 3 Retention and Social Plan

**Goal:** Ship private diary retention first, then complete safe social lifecycle and a competition-first dashboard before Phase 4 quality work.

## Slice 1 — Audited diary entries (this change)

- Keep `watches` as the historical event and store owner-controlled rating (integer 0–100), review, private notes, favorite, canonical sorted JSON tags, venue, visibility, and watched instant on that event.
- Canonical JSON tags are bounded to 20 unique normalized tags of 1–30 characters and sorted deterministically. This avoids a join-heavy tag model while preserving stable equality and migration simplicity; service and DB checks bound storage.
- Owner-only read/PATCH contracts reject mass assignment and invalid values. Private notes exist only in the owner diary DTO.
- Date changes are limited to active manual watches without provider-proof dependencies. They require exact `YYYY-MM-DDTHH:mm:ss.sssZ`, derive the local day with the owner timezone, reject direct or indirect effects on ended or frozen seasons, and atomically reconcile duplicate-state episodes, lifetime append-only score corrections, achievements/streak bases, and active season projections. Provider-attested timestamps and provider identity are immutable. External achievement preparation occurs before the write transaction, followed by a second in-transaction frozen-state check.
- Movie history exposes a secondary accessible editor; Quick Log remains one tap.

## Slice 2 — Social lifecycle

1. Migrate friend rows to explicit outgoing/incoming/accepted/blocked lifecycle with append-only actor audit and unique unordered pair identity.
2. Add expiring shareable friend invites, outgoing request listing, cancel, remove, and block/unblock APIs with CSRF and ownership tests.
3. Filter all diary activity by visibility; never select private notes into social DTOs. Add request-race, block, replay, and leakage tests.
4. Add compact Friends controls for incoming/outgoing states and safe confirmation on destructive actions.

## Slice 3 — Competition-first dashboard

1. Add one private dashboard projection for current league rank, pass distance, active challenge, season end, and recent league activity.
2. Keep trending fail-open and secondary. Bound all lists and include the current user even outside the first leaderboard page.
3. Add empty/loading/error states, mobile hierarchy, integrity tests, build, and desktop/mobile acceptance.

## Phase 4 — Technical quality

1. Complete route/service/repository separation and shared strict schemas/API documentation after a compatibility spike.
2. Add TMDB timeout/retry/cache/concurrency controls without provider calls in write transactions.
3. Add the established frontend test harness, Playwright, accessibility checks, abortable fetches, and contract tests.
4. Run a documentation truth pass for auth, privacy, sync, scoring, backup/restore, roadmap, and screenshots.

Each slice uses RED → GREEN, full server tests, web build, integrity review, changelog updates, and an independently reviewable Conventional Commit.
