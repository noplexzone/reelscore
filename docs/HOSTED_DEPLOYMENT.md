# Hosted ReelScore deployment

Hosted mode uses the normal ReelScore image, but it **must** use a separate container, hostname, secrets, tunnel, and data directory from the private instance. `docker-compose.hosted.yml` publishes no ReelScore port. ReelScore and cloudflared share only an internal origin network; each also has its own separate egress network.

## Required configuration

1. Set `HOSTED_DATA_DIR` to a new, dedicated directory. It must not be `/mnt/user/appdata/reelscore` or any private instance directory.
2. Set an exact HTTPS-origin `PUBLIC_URL`.
3. Generate independent `SESSION_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` values.
4. Set `PLEX_ALLOWED_SERVER_ID`, `PLEX_CLIENT_IDENTIFIER`, and `PLEX_ALLOWED_ORIGINS`. Every credential-bearing Plex destination must match an exact independently configured origin before ReelScore sends a token.
5. Keep `REGISTRATION_MODE=invite` or `closed`.
6. Store the dedicated tunnel token in a mode-0600 file and set `CLOUDFLARE_TUNNEL_TOKEN_FILE` to its absolute path. Compose mounts it as a secret. The tunnel origin is `http://reelscore-hosted:3000`.
7. Do not publish port 3000/3210. The Compose file trusts only the pinned cloudflared peer (`172.29.0.2/32`), never a forwarded-hop count. Cloudflared and ReelScore share only the internal origin network; each has a separate outbound-only bridge network so provider traffic works without making the application reachable from unrelated containers.

## First administrator

For a fresh hosted database only:

1. Generate `BOOTSTRAP_ADMIN_TOKEN` with `openssl rand -hex 32`.
2. Start the disposable hosted stack.
3. Send one request with the exact public Origin:

```sh
curl --fail-with-body -X POST "$PUBLIC_URL/api/auth/bootstrap" \
  -H "Origin: $PUBLIC_URL" \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Token: $BOOTSTRAP_ADMIN_TOKEN" \
  --data '{"username":"admin","password":"replace-with-a-long-unique-password"}'
```

4. Confirm the account is an administrator, remove `BOOTSTRAP_ADMIN_TOKEN`, and restart. The database permanently records consumption; replay and later bootstrap attempts fail.

## Migration rehearsal and cutover gate

Never rehearse against the live database. With the private container stopped or from an already verified SQLite backup, copy the DB into a disposable hosted data directory, start the candidate image there, and compare users, watches, achievements, friendships, connections, schema version, and `PRAGMA integrity_check`. Verify the automatically generated pre-migration backup independently.

Do not attach the public hostname until server tests, web build, dependency audits, hosted request-boundary tests, provider tests, migration rehearsal, and disposable-container health/smoke checks all pass.

## Rollback and restore

Schema migrations are forward-only. Rolling the image back while retaining a newer database is unsupported.

1. Stop the hosted stack; do not restart an older image against the migrated database.
2. Preserve the failed database, WAL, SHM, and logs for diagnosis.
3. Move the entire failed hosted data directory aside.
4. Restore the verified pre-migration SQLite backup into a clean hosted data directory as `reelscore.db`, owned by UID 99/GID 100 with directory permissions `0700` and file permissions `0600`.
5. Run `PRAGMA integrity_check` and verify critical row counts before starting the previous image.
6. Start the previous image with the restored schema-compatible DB, verify locally, and only then re-enable tunnel routing.

A production/private cutover, container replacement, or restart remains a separately authorized operation.

## Provider sync and reconciliation

Normal sync is additive and never moves, deletes, converts, or recomputes manual rows. Stable connection-scoped event identities make repeat and concurrent imports idempotent. Explicit admin reconciliation previews a chosen placeholder date and updates only selected manual rows; unmatched and unselected rows remain byte-for-byte unchanged.

Plex owner PIN links use local account ID 1. Shared-user links must produce one unambiguous account and persist that account per encrypted connection. Legacy/manual links may use `PLEX_HISTORY_ACCOUNT_ID`.
