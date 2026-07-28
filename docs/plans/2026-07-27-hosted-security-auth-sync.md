# Hosted Security, Provider Authentication, and Safe Sync Plan

> **For Hermes:** Implement task-by-task with Claude Code. Jarvis verifies and publishes only `:develop`. Do not restart the running ReelScore container.

**Goal:** Make ReelScore safe for public Cloudflare-Tunnel hosting while preserving Caleb's and his wife's existing accounts and data.

**Architecture:** Add `APP_MODE=self_hosted|hosted`; migrate JWT/localStorage auth to revocable HttpOnly-cookie sessions; add roles, invites, provider identities, encrypted credentials, Plex/Trakt login, allowed-Plex-server admission, safe history reconciliation, admin UI, and hosted security controls.

**Stack:** Node 22, Express, better-sqlite3, React/Vite, Node crypto, Plex API v2, Trakt OAuth, Docker.

## Global constraints

- Never modify development/verification against `/mnt/user/appdata/reelscore/reelscore.db`.
- Verified backup: `/mnt/user/data/media/obsidian/JARVIS/Backups/reelscore/reelscore-pre-hosted-20260728T024834Z.db` (`integrity_check=ok`; 2 users, 430 watches, 102 achievements, 1 friendship).
- Before schema migration on a non-empty `/data`, create and integrity-check a timestamped `/data/backups/` database backup. Preserve all users, hashes, watches, achievements, friendships, and settings.
- If no admin exists, migrate only the oldest existing user to admin. Existing password logins continue. Hosted mode disables public password registration, not existing-user login.
- `APP_MODE` defaults to `self_hosted`. Hosted mode fails closed without valid `PUBLIC_URL`, secure session/encryption secrets, explicit registration policy, and safe proxy configuration.
- Hosted mode never fetches a user-supplied Plex URL. Plex connections come only from Plex PIN authentication and resource discovery; `PLEX_ALLOWED_SERVER_ID` can restrict admission/sync to Caleb's server.
- Provider identities use immutable IDs. Provider tokens are AEAD-encrypted at rest with a dedicated key and never returned/logged.
- Auth uses random opaque session cookies; only token hashes are stored. Cookies: HttpOnly, SameSite=Lax, Path=/, Secure in hosted mode. Mutations require CSRF. Logout, disable, and session revocation are immediate.
- OAuth/PIN state is random, expiring, one-time, browser-bound, and action-bound. Account merging requires an authenticated session.
- Hosted registration supports `closed`, `invite` (default), and `plex_server`. Trakt-only first login requires an invite unless already linked.
- Validate Host/Origin against `PUBLIC_URL`; exact configurable `TRUST_PROXY`; CSP/security headers; bounded bodies; provider timeouts; no unsafe redirects; rate limits. Never blindly trust forwarded headers.
- Admin controls: list/search users, role/status, provider/sync state without secrets, create/revoke invites, disable/reactivate users, revoke sessions. No destructive user deletion.
- Plex sync uses individual playback-history events and stable provider event IDs with database uniqueness and transaction-safe idempotency.
- Initial Plex sync may reuse an unmatched manual row for the same movie whose `watched_at` is today, replacing its placeholder date/source with the Plex event. Keep existing exact-same-day upgrade behavior.
- Never delete unmatched manual watches. A manual item such as *The Odyssey* that is absent from Plex must remain unchanged.
- Recompute watch `is_rewatch`/points chronologically after reconciliation using event timestamps, never `Date.now()`. Existing achievements remain.
- Trakt refreshes expired tokens automatically.
- No running-container restart/recreate, tunnel exposure, stable tag, or `latest`. Publish only `noplexzone/reelscore:develop` after review and verification.

## Task 1 — Safe migration and session auth

Create versioned backup-first migrations and tables/columns for roles/status, sessions, provider identities, encrypted connections, OAuth flows, invites, audit log, schema versions, and provider-event watch identity. Replace browser JWT/localStorage auth with cookie sessions and CSRF.

TDD: legacy-copy migration preserves rows and creates a valid backup; oldest-only admin bootstrap; password login cookie/CSRF; logout/expiry/disable/revoke; cookie attributes by mode; no localStorage token.

Commit: `feat(auth): add safe migrations and revocable sessions`

## Task 2 — Hosted security boundary and admin/invites

Add fail-closed config, trusted-proxy/Host/Origin enforcement, Helmet/CSP, bounded parsing, provider/auth rate limits, role/status middleware, invite storage/consumption, audit events, admin API and initial admin UI.

TDD: invalid hosted config fails; hosted register closed while self-hosted remains; spoofed forwarding rejected; admin routes/fields safe; invites hashed/one-time/expiring/revocable.

Commit: `feat(hosted): add admin controls and public security boundary`

## Task 3 — Plex/Trakt sign-in and linking

Add Plex PIN/JWT initiation/polling, `/api/v2/user`, resource discovery/allowed machine validation, selected resource token storage, and provider login/link flows. Add Trakt authorization-code login/callback plus existing device-link support and token refresh. Encrypt all credentials. Hosted connections reject raw token/server URL.

TDD against local stubs: login/link, immutable identity, no unauthenticated merge, one-time flow, allowed server admission, arbitrary URL rejection, ciphertext at rest, Trakt refresh/retry.

Commit: `feat(auth): add secure Plex and Trakt sign-in`

## Task 4 — Full idempotent history reconciliation

Use Plex playback-history pagination and resolve TMDB IDs. Refactor `importHistory` to stable event IDs, transactions/uniqueness, deterministic today-placeholder reuse, same-day upgrade, no unmatched-manual deletion, and chronological recalculation.

TDD: 1-day historical rewatch gets zero; >30 days gets 25%; future watches do not affect old events; concurrent/repeated imports dedupe; multiple Plex events remain multiple; today manual row receives real Plex date; same-day upgrade works; unmatched *The Odyssey* row is bit-for-bit unchanged; achievements remain.

Commit: `fix(sync): reconcile provider history without data loss`

## Task 5 — Onboarding, docs, deployment contract

Complete provider login/invite/username/server-selection/initial-sync UX, admin page, and self-hosted advanced manual connection outside hosted mode. Update README, changelog, `.env.example`, compose env wiring, and hosted Cloudflare guidance: separate public instance/data path, exact proxy/host config, no directly exposed origin, backup/rollback, `APP_MODE=hosted` activation.

Verify server suite, web build/audits, fresh-data production container, migrated copy of verified backup, browser login/admin/onboarding/mobile, console/network, PWA, and no production restart.

Commit: `feat(hosted): complete secure onboarding and deployment docs`

## Task 6 — Review, remediation, publication

Independent fixed-commit spec then security/data review (OAuth, session, CSRF, SSRF, crypto, proxy, migration, concurrency). Fix all critical/important findings and re-review. Jarvis runs final diff/secret scan/tests/audits/build/fresh+migrated Docker/browser gates, pushes, waits for CI, publishes only `noplexzone/reelscore:develop`, verifies digest, and provides new env/migration/rollback instructions. Tunnel and running-container update remain Caleb approval gates.
