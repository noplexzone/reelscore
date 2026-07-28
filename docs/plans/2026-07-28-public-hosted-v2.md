# Public Hosted ReelScore v2 Implementation Plan

> **For Hermes:** Execute task-by-task with TDD, coherent commits, independent review, and the public-hosted release gate.

**Goal:** Convert ReelScore from invite/provider-login hosting into a public verified-account service with optional read-only provider sync and privacy-safe lifecycle controls.

**Architecture:** Preserve Express/React/SQLite and self-hosted mode. Add verified local identity, durable email/jobs, MFA, link-only providers, multi-source watch provenance, lifecycle/privacy controls, and separate hosted deployment. Plex ships only if a feasibility probe proves universal shared-user history safe.

**Tech Stack:** Node 22, Express 4, better-sqlite3, React 18, Vite 8, Cloudflare Tunnel, transactional email adapter.

## Global constraints
- Workspace: `/mnt/user/appdata/dev/_scratch/reelscore-public-hosted`.
- Branch: `feat/public-hosted-v2`, based on `origin/main` at `98eb9ab`.
- Preserve self-hosted behavior and all existing data.
- Do not modify/restart the live container or database.
- Provider sync never silently overwrites manual rows.
- Providers are link-only and read-only.
- Movies only at launch; television events are ignored.
- Hosted startup must work without Plex configuration.
- No arbitrary hosted Plex URLs.
- One active writer per worktree.
- Pipeline: Light implementation -> L review -> Light remediation -> Jarvis release.
- Every migration gets a WAL-consistent backup and real-data-copy rehearsal.
- Acceptance publication uses only `noplexzone/reelscore:develop`; no semver or `latest`.

---

### Task 1: Verified email account foundation

**Owner/Gate:** Light implementation -> L security/spec review -> Jarvis verification.

**Objective:** Open hosted email/password registration, verification, resend, password reset, and existing-user email claim without weakening self-hosted mode.

**Files:**
- Modify: `server/src/db.js`, `server/src/config.js`, `server/src/auth.js`, `server/src/index.js`
- Create: `server/src/email.js`, `server/src/account-tokens.js`
- Test: `server/test/migration.test.js`, `config.test.js`, `auth.test.js`, `session.test.js`, new `email.test.js`
- Modify: `web/src/pages/Login.jsx`, `web/src/App.jsx`, `web/src/api.js`, `web/src/styles.css`
- Create: `web/src/pages/VerifyEmail.jsx`, `ForgotPassword.jsx`, `ResetPassword.jsx`
- Modify: `.env.example`, `CHANGELOG.md`

**Interfaces:** `sendVerification`, `sendPasswordReset`, token issue/consume helpers, `/api/auth/register`, `/verify-email`, `/verification/resend`, `/password-reset/request`, `/password-reset/complete`. Hosted register accepts `{email,password,username}`, returns a generic pending response, and creates no session.

**TDD:**
1. Write migration tests for normalized unique email, verification state, one-use account tokens, email jobs, and preserved legacy rows; verify RED.
2. Implement additive migration and canonical expiry.
3. Write API tests for open hosted registration, enumeration resistance, verification expiry/replay, resend invalidation, reset session revocation, and provider denial before verification; verify RED.
4. Implement keyed token digests, password policy, routes, and capture email adapter.
5. Add frontend flows.
6. Run server suite/audit, web build/audit, `git diff --check`.
7. Commit `feat(auth): add verified public accounts`.

### Task 2: Optional TOTP MFA and account security

**Prerequisite:** Task 1 approved.

**Objective:** TOTP setup/confirmation, login challenge, recovery codes, disable/reset, and session management.

**Files:** modify `server/src/db.js`, `auth.js`, `providers.js`; create `server/src/mfa.js`; add `server/test/mfa.test.js`; modify session/admin tests and `server/package.json`; create `web/src/pages/Settings.jsx`, `MfaChallenge.jsx`; modify Login/App/api/styles/CHANGELOG.

**Interfaces:** `beginTotpSetup`, `confirmTotpSetup`, `verifyLoginChallenge`, `consumeRecoveryCode`. Full session issuance only after MFA where enabled.

**TDD:** encrypted pending setup, invalid/valid confirmation, replay-safe challenge, one-use recovery, expiry precision, and revocation on reset. Full checks, then commit `feat(auth): add optional authenticator MFA`.

### Task 3: Link-only providers and Plex capability gate

**Prerequisite:** Task 1 approved. Plex research runs independently.

**Objective:** Remove provider registration/login, require verified authenticated linking, preserve one identity per provider, and make Plex optional.

**Files:** modify `server/src/provider-auth.js`, `config.js`, `routes/connections.js`, `index.js`; provider/hosted/config/security tests; Login/Connections UI; `.env.example`, Compose, hosted docs, changelog. Create `docs/research/plex-public-history-feasibility.md`.

**Interfaces:** only `action='link'`; verified session + CSRF required; completion cannot create users/sessions. `/api/connections` returns `available`, `coming_later`, `linked`, or `action_required`.

**TDD:** anonymous/provider login rejected, verified link succeeds, unverified link fails, identity collision fails, Trakt-only hosted startup succeeds, absent Plex config reports coming later. Implement Plex only if research approves. Commit `refactor(providers): make providers account connections`.

### Task 4: Initial import boundaries and durable sync jobs

**Prerequisite:** Tasks 1 and 3 approved.

**Objective:** All-history/start-date setup, daily imports, and manual Sync through one lease-based job system.

**Files:** modify `server/src/db.js`, `sync.js`, `routes/connections.js`, `index.js`; create `jobs.js`, `scheduler.js`, `jobs.test.js`; modify sync/provider tests and package script; update Connections/Settings/styles/env/changelog.

**Interfaces:** connection stores `import_from`, status, failure count/class, next run, notification cooldown. `enqueueSync({userId,provider,reason})` is idempotent; workers claim leases with bounded concurrency.

**TDD:** date filtering, all-history, duplicate manual requests, lease recovery, daily scheduling, poison-job progress, retries, and notification threshold. Commit `feat(sync): add durable scheduled imports`.

### Task 5: Multi-source provenance and user reconciliation

**Prerequisite:** Task 4 approved.

**Objective:** One watch with multiple provider sources, confident Plex/Trakt merging, and user-reviewed manual reconciliation.

**Files:** modify `server/src/db.js`, `sync.js`, `routes/api.js`, `admin.js`, `connections.js`; migration/sync/scoring/admin tests; create `web/src/components/Reconciliation.jsx`; modify Settings/Movie/styles/changelog.

**Interfaces:** `watch_sources` owns immutable source identity. Provider matching requires equal TMDB ID plus narrow time tolerance; ambiguity never auto-merges. User preview returns opaque IDs and one-use nonce; apply changes selected candidates only.

**TDD:** migration backfill, same event across providers, legitimate rewatch, ambiguous timestamps, replay/stale preview, manual byte preservation, equal-second scoring, concurrent import. Commit `feat(sync): merge multi-provider watch provenance`.

### Task 6: Profile privacy and account lifecycle

**Prerequisite:** Tasks 1 and 5 approved.

**Objective:** Field-level public profiles, internal discovery/noindex, export, disconnect choices, permanent deletion.

**Files:** modify `server/src/db.js`, `routes/api.js`, `connections.js`, `auth.js`, `index.js`; create `account-lifecycle.js`, privacy and lifecycle tests; modify Profile/Friends/Settings/Connections/App/styles/changelog.

**Interfaces:** distinct private/public DTOs; first public opt-in defaults score/achievements on. Export omits secrets. Disconnect and delete use preview/explicit CSRF-protected apply.

**TDD:** private defaults, field projection, internal discovery, noindex, mixed-source deletion, export secret scan, sole-admin delete refusal, complete cascade. Commit `feat(accounts): add privacy and lifecycle controls`.

### Task 7: Sole-admin operations and production email

**Prerequisite:** Tasks 1, 2, 4 and email-provider decision.

**Objective:** Complete moderation/sync controls and production email delivery.

**Files:** modify `server/src/routes/admin.js`, `email.js`, `jobs.js`, `config.js`; admin/email/jobs/config tests; Admin UI/styles/env/Compose/hosted docs/changelog.

**Interfaces:** suspend/reactivate, session/MFA/provider revoke, profile hide, job retry, blocklist, secret-free audit. Production adapter uses timeouts and idempotency keys.

**TDD:** authorization, self-lockout prevention, redacted DTOs, blocked registration, retry idempotency, provider failure handling, template escaping. Commit `feat(admin): add hosted operations controls`.

### Task 8: Integrated verification and publication

**Prerequisite:** Tasks 1-7 approved. **Owner:** L whole-branch review -> Light remediation -> Jarvis release.

1. Full server test/audit, web build/audit, diff checks.
2. Inspect `origin/main..HEAD` and secret-scan additions.
3. Rehearse final migrations against real backup copy; compare user-owned counts, sources, and integrity.
4. Independent security/spec review and bounded remediation.
5. Disposable hosted smoke: registration, captured verification, login, MFA, Trakt stub link/import, privacy, disconnect, deletion, Host/Origin rejection, health, restart persistence.
6. Push/merge only after approval; wait for CI/Docker publication.
7. Verify `:develop` index digest and runnable amd64 manifest map to intended commit.
8. Smoke the registry-published immutable digest.
9. Update `/mnt/user/appdata/dev/CONTAINERS.md` and report the literal pull line.

**Completion:** clean pushed tree, green CI, verified registry digest, disposable runtime evidence, no live deployment mutation.
