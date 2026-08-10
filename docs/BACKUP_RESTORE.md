# Backup and restore

ReelScore stores durable state under `DATA_DIR` (normally the `/data` container mount). The primary database is `/data/reelscore.db`; migration snapshots are written under `/data/backups/`.

## Rules

- Do not copy only `reelscore.db` while the application is running. SQLite WAL frames may contain committed data not yet present in that file.
- Use ReelScore's `VACUUM INTO` backup path for an online, transactionally consistent snapshot.
- Verify the snapshot independently before relying on it.
- Migrations are forward-only. Never run an older image against a database migrated by a newer image.
- A production container stop, replacement, or restore requires separate approval.

## Create and verify an online snapshot

From the directory containing `docker-compose.yml`:

```sh
docker compose exec reelscore node --input-type=module -e '
  const { createBackup } = await import("./src/db.js");
  const result = createBackup();
  console.log(result.path);
'
```

The command returns a path such as `/data/backups/reelscore-pre-hosted-<timestamp>.db`. It fails instead of returning success if source or snapshot integrity is not `ok`.

Verify a selected snapshot again and record critical counts:

```sh
BACKUP=/data/backups/reelscore-pre-hosted-<timestamp>.db
docker compose exec -e BACKUP="$BACKUP" reelscore node --input-type=module -e '
  import Database from "better-sqlite3";
  const db = new Database(process.env.BACKUP, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check")[0]?.integrity_check;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type=?").all("table").map(row => row.name));
  const wanted = ["users", "watches", "achievements", "score_events", "duplicate_cases"];
  const counts = Object.fromEntries(wanted.filter(table => tables.has(table)).map(
    table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]
  ));
  const schemaVersion = tables.has("schema_versions")
    ? db.prepare("SELECT MAX(version) AS version FROM schema_versions").get().version
    : 0;
  console.log(JSON.stringify({ integrity, schemaVersion, counts }));
  db.close();
  if (integrity !== "ok") process.exit(1);
'
```

Copy the verified snapshot to storage outside the application data directory according to the host's backup policy. Preserve its recorded integrity result, schema version, image digest, and counts.

## Automatic migration snapshots

Before any pending migration on a populated database, startup creates and verifies an online snapshot under `/data/backups/`. Startup refuses to migrate if backup creation or either integrity check fails. Versions 7 and 8 use this gate.

An automatic snapshot protects the pre-migration schema. It is not a substitute for regular off-host backups.

## Restore rehearsal

Rehearse only in a disposable directory and with an anonymous or separately named test container. Never point a rehearsal at the live `/data` mount.

1. Copy the selected snapshot to an empty disposable directory as `reelscore.db`.
2. Set directory ownership to UID 99/GID 100 and permissions to `0700`; set the database to `0600`.
3. Start the exact candidate or rollback image with that directory mounted at `/data` and a valid `SESSION_SECRET`.
4. Wait for `/api/health` to return HTTP 200.
5. Verify `PRAGMA integrity_check`, schema version, and the recorded critical counts.
6. Remove only the disposable test container and directory after recording results.

## Production restore

A restore is destructive and requires explicit authorization.

1. Stop the ReelScore container. Do not start an older image against the current migrated database.
2. Preserve the failed database, WAL, SHM, application logs, current image digest, and full data directory for diagnosis.
3. Move the failed data directory aside; do not overwrite it.
4. Create a clean data directory owned by UID 99/GID 100 with mode `0700`.
5. Copy the verified schema-compatible snapshot into it as `reelscore.db`, owned by UID 99/GID 100 with mode `0600`.
6. Verify integrity and critical counts before startup.
7. Start the exact image compatible with that snapshot.
8. Verify `/api/health`, login, lifetime totals, watch counts, achievements, duplicate queue, and provider connection status before restoring public routing.

For hosted deployments, also follow [`HOSTED_DEPLOYMENT.md`](HOSTED_DEPLOYMENT.md); keep the hosted and private data directories, secrets, containers, and hostnames separate.
