# Hosted ReelScore deployment

This uses the normal `noplexzone/reelscore:develop` image and the existing `/data` volume. There is no separate public edition.

## Hard gates before attaching Cloudflare Tunnel

1. Use a unique HTTPS hostname and set `PUBLIC_URL` to that exact origin.
2. Generate independent `SESSION_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` values. Never reuse Plex, Trakt, JWT, or Cloudflare credentials.
3. Set `PLEX_ALLOWED_SERVER_ID` to the Plex machine identifier users must be able to access.
4. Keep `REGISTRATION_MODE=invite` or `closed`; hosted mode rejects `open`.
5. Ensure `/mnt/user/appdata/reelscore`, the database, WAL, and SHM files are writable by UID 99/GID 100 before changing to the non-root image. Back up first.
6. Run the migration rehearsal against a copy of the real database and confirm row counts/integrity.
7. Build and run the image against disposable data; pass server tests, browser smoke tests, audits, and the hosted security review.
8. Remove the host port mapping. Attach ReelScore and `cloudflared` only to the private `reelscore-tunnel` network. Point the tunnel origin at `http://reelscore:3000`.
9. Set `TRUST_PROXY=1` only in that topology. Do not expose port 3000/3210 directly while trusting one forwarded hop.
10. Confirm invalid Host/Origin requests fail, cookies are Secure/HttpOnly/SameSite, and provider tokens never appear in APIs/logs.

## Data behavior during first provider sync

- Startup creates and integrity-checks a pre-migration database backup before schema changes.
- Normal sync never moves or deletes an unmatched manual watch.
- An explicit, admin-confirmed one-time onboarding reconciliation may preview and mark selected manually logged-today rows as replaceable, then update only those selected rows with Plex dates/provider identity.
- Manual rows not selected or not matched remain byte-for-byte unchanged. A manually logged unreleased or unavailable title such as The Odyssey is not removed merely because Plex does not return it.
- Stable provider event IDs make repeated/concurrent imports idempotent. Scoring is recomputed chronologically after watch dates change.

Plex owner PIN links restrict history to local Plex account ID 1. Shared-user
links are accepted only when the server response contains one unambiguous
account. `PLEX_HISTORY_ACCOUNT_ID` can explicitly scope a legacy/manual link.

The reconciliation preview defaults to the current UTC date. Set
`ONBOARDING_PLACEHOLDER_DATE=YYYY-MM-DD` or supply `placeholder_date` to the
admin preview endpoint when reviewing a different onboarding date.

## Cloudflare

The app does not require Cloudflare Access, but Access is recommended for a closed test. If the test is public, use app invites and Cloudflare rate limiting/bot controls. TLS terminates at Cloudflare; the hosted app still requires an `https://` `PUBLIC_URL` and Secure cookies.

Do not enable the tunnel until the release verification report explicitly says the hosted gates passed. Updating or restarting the running container remains a separate approved operation.
