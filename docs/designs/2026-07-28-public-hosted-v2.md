# Public Hosted ReelScore v2 Design

## Status
Approved product direction from Caleb on 2026-07-28. This replaces the invite-only, deployment-wide-Plex-server hosted model. Existing self-hosted behavior remains supported.

## Outcome
ReelScore becomes a public multi-tenant movie-tracking service for an initial ceiling of 100 registered users. Users own independent ReelScore accounts and optionally connect provider accounts as read-only history sources.

## Product invariants
- Hosted registration is open to anyone using a unique email address and password.
- Email verification is required before provider linking or history import.
- Plex and Trakt are connections, never primary ReelScore login methods.
- One Plex and one Trakt account may be linked per ReelScore user.
- Provider access is read-only; ReelScore never writes to Plex or Trakt.
- Trakt history sync is required at launch.
- Universal Plex import for owners and shared-library-only users is a feasibility gate. If unsafe or unavailable, launch with Trakt and manual entry and show Plex as coming later.
- Movies only at launch; television is ignored until a later release.
- Initial import asks for all history or a user-selected start date.
- Automatic sync runs daily; a rate-limited manual Sync button remains.
- Likely duplicate Plex/Trakt events merge into one watch with both immutable source references. Title-only matching is forbidden.
- Manual watch entry/editing remain. Manual/provider matches require explicit user approval.
- Profiles are private by default. Public profiles expose field-level choices; first opt-in defaults to achievements and aggregate score only.
- Opted-in profiles are searchable inside ReelScore but excluded from search-engine indexing.
- Provider disconnect asks whether to retain imported history or delete provider-exclusive history.
- Account deletion immediately removes the account, credentials, sessions, MFA data, history, scores, friendships, and profile material.
- Optional authenticator-app TOTP MFA and recovery codes ship at launch.
- Caleb is the sole administrator.
- No live container, database, hostname, or tunnel changes before separately authorized cutover.

## Architecture

### Identity and authentication
`users` gains normalized email identity and verification state while retaining `username` as a display/URL handle. Hosted registration creates a pending user and one-use hashed verification token; it does not issue an authenticated session before verification. Existing migrated users continue to sign in and receive a controlled email-claim flow rather than being locked out.

Password-reset and verification responses are enumeration-resistant. Tokens are random, stored only as keyed digests, one-use, expiring, and consumed transactionally. Existing opaque HMAC-hashed cookie sessions, CSRF, exact Host/Origin checks, idle/absolute expiry, and session caps remain.

Optional MFA uses encrypted TOTP secrets with field-specific AAD. Setup remains pending until a valid TOTP is confirmed. Recovery codes are random and individually HMAC-hashed. MFA login uses a short-lived one-use challenge; no full session is issued before completion.

### Email boundary
Application code calls a provider-neutral internal adapter. Production delivery uses **Resend Free** initially through its HTTP API; tests use deterministic capture delivery. Resend was selected after a five-provider comparison for its 3,000-message monthly allowance, signed webhooks, idempotency, suppression handling, and low operational burden. Upgrade before the 100-message daily ceiling can block authentication mail.

```js
sendVerification({ to, verifyUrl, expiresAt })
sendPasswordReset({ to, resetUrl, expiresAt })
sendSyncActionRequired({ to, provider, settingsUrl, failureSummary })
```

Delivery is backed by durable jobs; no request starts an untracked fire-and-forget send. Verification, reset, and security mail outrank sync notices. Messages contain no credentials or sensitive history. The sending subdomain uses DNS-only DKIM/SPF/MX records and monitored DMARC.

### Provider linking
Provider starts require an authenticated, verified user and CSRF. Provider flow actions are link-only. Completion may attach an immutable provider identity to the same user but can never create or sign in a ReelScore user. Existing provider-login routes/UI are removed.

Trakt OAuth remains encrypted, refreshable, one-use, browser/session-bound, and exact-redirect-bound. **Plex is `coming_later` for the public launch:** Plex exposes no supported hosted account API for complete watch-event history, while per-server history requires reaching user-accessible PMS instances and introduces completeness, availability, and SSRF constraints. Hosted startup therefore works without Plex configuration. A future Plex capability may ship only as explicitly best-effort after a controlled account/PMS spike and isolated connector design.

### Watch ledger and provenance
A watch is the scored event. Provider observations move to:

```text
watch_sources(
  id, watch_id, user_id, provider, connection_subject,
  provider_event_id, observed_at, created_at,
  UNIQUE(user_id, provider, connection_subject, provider_event_id)
)
```

Manual watches have no source unless the user approves reconciliation. A watch may have both Plex and Trakt sources. Provider-to-provider matching requires the same stable movie identity and a narrow timestamp window; ambiguous candidates remain separate. Merging never discards provenance.

Initial import policy is stored per connection (`import_from`, null means all history). Sync state records attempts, successes, failure class/count, next run, and notification cooldown. Daily jobs are claimed transactionally with leases and bounded concurrency. Manual sync uses the same durable job path.

### Privacy and lifecycle
Profile visibility stores public opt-in and field flags independently. Public APIs use a dedicated projection and never reuse private DTOs. Public routes emit `X-Robots-Tag: noindex, nofollow` and corresponding metadata.

Account export produces user-scoped JSON without decrypted credentials. Disconnect uses preview plus explicit keep/delete choice. Account deletion verifies password and MFA when enabled, revokes credentials/sessions first, and removes user-owned rows transactionally.

### Administration
The sole-admin surface provides account search, suspension/reactivation, session revocation, MFA reset, provider revocation, profile hiding, sync inspection/retry, blocked email/domain policy, and security audit events. It never returns hashes, ciphertext, tokens, or recovery codes. Self-disable and loss of the last active administrator remain forbidden.

### Deployment
Public hosting remains a separate container, database directory, hostname, secrets, tunnel, and email credentials with no host-published app port. SQLite remains suitable for 100 users with WAL-consistent backups, indexed job claims, one scheduler leader, and bounded provider concurrency.

## Migration strategy
1. Additive migrations only; back up before every pending migration.
2. Preserve users, watches, achievements, friendships, and provider rows.
3. Existing users without email remain able to sign in and are prompted to claim/verify email before provider actions.
4. Backfill each provider watch into one `watch_sources` row without rewriting manual rows.
5. Retain legacy provenance columns during compatibility; remove only in a later release.
6. Rehearse final schema against a copy of the real database and compare counts plus `PRAGMA integrity_check`.

## Security and abuse boundaries
- Normalize email conservatively with trim/lowercase and a unique index; do not canonicalize provider-specific aliases.
- Separately rate-limit registration, resend, login, reset, MFA, provider starts, and manual sync.
- Use exact token expiry semantics and test just-before/exact/just-after expiry.
- Require verified email for linking, imports, public-profile opt-in, and export.
- Encrypt TOTP and provider credentials with versioned AEAD and field-specific AAD.
- Escape all usernames/profile/email/provider/admin output.
- Never contact arbitrary Plex URLs from hosted mode.
- Jobs are idempotent, lease-based, retry-bounded, and resistant to poison-row starvation.

## Release gates
- Registration, verification, login, reset, MFA, and recovery are browser-smoked.
- Provider login is impossible; linking requires a verified authenticated session.
- Trakt respects import boundary and is idempotent.
- Cross-provider duplicate tests retain both sources.
- Manual merge tests prove no mutation before explicit apply.
- Privacy projection and noindex probes pass.
- Disconnect, export, and deletion pass adversarial tests.
- Admin operations are sole-admin-safe and secret-free.
- Real-data-copy migration rehearsal preserves data and integrity.
- Independent security review approves a stable commit range.
- Exact registry digest passes disposable hosted runtime smoke.
- Tunnel attachment remains separately authorized.
