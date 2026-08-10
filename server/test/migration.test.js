// Must set env vars before any module imports so db.js picks up the right DATA_DIR.
process.env.DATA_DIR = `/tmp/rs-migration-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR;
const DB_PATH = path.join(DATA_DIR, "reelscore.db");

// ---------------------------------------------------------------------------
// Build a legacy DB with pre-migration data BEFORE importing db.js.
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });

{
  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      public_profile INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      poster_path TEXT,
      vote_average REAL,
      runtime INTEGER,
      release_date TEXT,
      genres TEXT,
      collection_id INTEGER,
      collection_name TEXT,
      points INTEGER NOT NULL,
      is_rewatch INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      watched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      points INTEGER NOT NULL DEFAULT 0,
      unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, key)
    );
    CREATE TABLE friends (
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE TABLE connections (
      user_id INTEGER NOT NULL,
      service TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      server_url TEXT,
      service_username TEXT,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at TEXT,
      PRIMARY KEY (user_id, service)
    );
  `);

  // Insert legacy test data matching the verified backup count.
  legacy.prepare(`
    INSERT INTO users (username, password_hash, created_at) VALUES
    ('alice', '$2a$10$legacyhash1', '2024-01-01 00:00:00'),
    ('bob',   '$2a$10$legacyhash2', '2024-02-01 00:00:00')
  `).run();

  // Four watches for alice (including zero-point cooldown + paid rewatch), two for bob.
  legacy.prepare(`
    INSERT INTO watches (user_id, tmdb_id, title, points, watched_at) VALUES
    (1, 1000, 'Film A', 50, '2024-01-10 20:00:00'),
    (1, 1001, 'Film B', 45, '2024-01-15 20:00:00'),
    (1, 1000, 'Film A cooldown', 0, '2024-01-20 20:00:00'),
    (1, 1000, 'Film A rewatch', 10, '2024-03-20 20:00:00'),
    (2, 1002, 'Film C', 60, '2024-02-10 20:00:00'),
    (2, 1003, 'Film D', 55, '2024-02-15 20:00:00')
  `).run();

  legacy.prepare(`
    INSERT INTO achievements (user_id, key, name, points) VALUES
    (1, 'volume:10', 'Watched 10', 100),
    (2, 'genre:Drama:5', 'Drama Novice', 50)
  `).run();

  legacy.prepare(`
    INSERT INTO friends (user_id, friend_id, status, requested_by) VALUES
    (1, 2, 'accepted', 1)
  `).run();

  legacy.close();
}

// ---------------------------------------------------------------------------
// Now import db.js (which calls runMigrations on the legacy DB).
// ---------------------------------------------------------------------------

const { db, runMigrations, createBackup, tableExists, DATA_DIR: DD } = await import("../src/db.js");

test("migration: original users are preserved", () => {
  const users = db.prepare("SELECT * FROM users ORDER BY id").all();
  assert.equal(users.length, 2);
  assert.equal(users[0].username, "alice");
  assert.equal(users[1].username, "bob");
  // Password hashes untouched.
  assert.equal(users[0].password_hash, "$2a$10$legacyhash1");
  assert.equal(users[1].password_hash, "$2a$10$legacyhash2");
});

test("migration: watches are preserved (6 rows)", () => {
  const count = db.prepare("SELECT COUNT(*) c FROM watches").get().c;
  assert.equal(count, 6);
});

test("migration: achievements are preserved (2 rows)", () => {
  const count = db.prepare("SELECT COUNT(*) c FROM achievements").get().c;
  assert.equal(count, 2);
});

test("migration: friendships are preserved (1 row)", () => {
  const count = db.prepare("SELECT COUNT(*) c FROM friends").get().c;
  assert.equal(count, 1);
});

test("migration: schema_versions table exists and version 1 is recorded", () => {
  assert.ok(tableExists("schema_versions"));
  const v = db.prepare("SELECT version FROM schema_versions WHERE version = 1").get();
  assert.ok(v);
});

test("migration: sessions and invites tables created", () => {
  assert.ok(tableExists("sessions"));
  assert.ok(tableExists("invites"));
  assert.ok(tableExists("audit_log"));
});

test("migration: users gain role and status columns", () => {
  const user = db.prepare("SELECT role, status FROM users WHERE id = 1").get();
  assert.ok(user, "user row exists");
  assert.equal(user.role, "admin"); // oldest user becomes admin
  assert.equal(user.status, "active");
});

test("migration: oldest user and only oldest user becomes admin", () => {
  const users = db.prepare("SELECT id, username, role FROM users ORDER BY id").all();
  assert.equal(users[0].role, "admin");
  assert.equal(users[1].role, "user");
});

test("migration: backup was created with valid integrity", () => {
  const backupsDir = path.join(DATA_DIR, "backups");
  assert.ok(fs.existsSync(backupsDir), "backups directory exists");
  const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".db"));
  assert.ok(files.length > 0, "at least one backup file exists");

  const backupPath = path.join(backupsDir, files[0]);
  const bdb = new Database(backupPath, { readonly: true });
  const check = bdb.pragma("integrity_check");
  bdb.close();
  assert.equal(check[0]?.integrity_check, "ok", "backup integrity check passes");
});

test("migration: backup preserves user count", () => {
  const backupsDir = path.join(DATA_DIR, "backups");
  const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".db"));
  const backupPath = path.join(backupsDir, files[0]);
  const bdb = new Database(backupPath, { readonly: true });
  // The backup was created before migration — it should have the legacy schema.
  const count = bdb.prepare("SELECT COUNT(*) c FROM users").get().c;
  bdb.close();
  assert.equal(count, 2, "backup has both users");
});

test("migration: idempotent — re-running runMigrations changes nothing", () => {
  const before = {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    watches: db.prepare("SELECT COUNT(*) c FROM watches").get().c,
    adminCount: db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c,
    version: db.prepare("SELECT COUNT(*) c FROM schema_versions").get().c,
  };

  runMigrations({ skipBackup: true });

  assert.equal(db.prepare("SELECT COUNT(*) c FROM users").get().c, before.users);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watches").get().c, before.watches);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c,
    before.adminCount
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM schema_versions").get().c,
    before.version
  );
});

test("migration: watches have provider event scope and reconciliation preview schema", () => {
  const columns = new Set(db.prepare("PRAGMA table_info(watches)").all().map((column) => column.name));
  assert.ok(columns.has("provider_event_id"));
  assert.ok(columns.has("provider_service"));
  assert.ok(columns.has("provider_connection_id"));
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_watches_event'").get().sql;
  assert.match(sql, /user_id, provider_service, provider_connection_id, provider_event_id/i);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reconciliation_previews'").get());
  assert.ok(db.prepare("SELECT version FROM schema_versions WHERE version=3").get());
});

test("migration: sessions gain idle tracking and bootstrap state is durable", () => {
  const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
  assert.ok(columns.includes("last_seen_at"));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_versions WHERE version=4").get());
});

test("migration: verified-account foundation preserves legacy null-email users and data", () => {
  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((row) => row.name));
  assert.ok(columns.has("email"));
  assert.ok(columns.has("email_normalized"));
  assert.ok(columns.has("email_verified_at"));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email IS NULL AND email_normalized IS NULL").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watches").get().c, 6);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_tokens'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_jobs'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_versions WHERE version=5").get());
});

test("migration: MFA secrets, one-use recovery codes, challenges, and safe session identifiers are additive", () => {
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((row) => row.name));
  assert.ok(userColumns.has("totp_pending_encrypted"));
  assert.ok(userColumns.has("totp_secret_encrypted"));
  assert.ok(userColumns.has("mfa_enabled_at"));
  assert.ok(new Set(db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name)).has("public_id"));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mfa_recovery_codes'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mfa_login_challenges'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_versions WHERE version=6").get());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watches").get().c, 6);
});

test("migration 7: adds competitive-integrity columns and records the version", () => {
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  assert.ok(columns("users").has("timezone"));
  for (const column of ["watched_at_utc", "watched_day_local", "timezone_used", "qualifies_for_volume", "qualifies_for_achievement", "qualifies_for_streak", "qualifies_for_season", "eligibility_status", "eligibility_rule_version", "eligibility_reason", "deleted_at", "deleted_reason", "logical_canonical_watch_id"]) assert.ok(columns("watches").has(column), `watches.${column}`);
  for (const column of ["score_event_id", "revoked_at", "revocation_reason"]) assert.ok(columns("achievements").has(column));
  assert.ok(db.prepare("SELECT 1 FROM schema_versions WHERE version=7").get());
});

test("migration 7: creates ledger and duplicate-review tables with foreign keys and indexes", () => {
  for (const table of ["score_events", "duplicate_cases", "duplicate_ignore_rules"]) assert.ok(tableExists(table), table);
  const scoreColumns = new Set(db.prepare("PRAGMA table_info(score_events)").all().map((row) => row.name));
  for (const column of ["id", "event_key", "user_id", "watch_id", "achievement_id", "season_id", "category", "points", "rule_version", "metadata_json", "created_at", "reversed_at", "reverses_event_id"]) assert.ok(scoreColumns.has(column), `score_events.${column}`);
  const fkTargets = new Set(db.prepare("PRAGMA foreign_key_list(score_events)").all().map((row) => row.table));
  for (const table of ["users", "watches", "achievements"]) assert.ok(fkTargets.has(table), `FK to ${table}`);
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  for (const name of ["idx_score_events_user_chronology", "idx_score_events_watch", "idx_score_events_achievement", "idx_watches_competitive_timeline", "idx_watches_streak_day", "idx_duplicate_cases_user_status", "idx_duplicate_cases_fingerprint"]) assert.ok(indexes.has(name), name);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("migration 8: supports explicit per-candidate cases and cancellation audit", () => {
  const duplicateColumns = new Set(db.prepare("PRAGMA table_info(duplicate_cases)").all().map((row) => row.name));
  assert.ok(duplicateColumns.has("cancelled_at"));
  assert.ok(duplicateColumns.has("cancellation_reason"));
  assert.ok(db.prepare("SELECT 1 FROM schema_versions WHERE version=8").get());
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_duplicate_cases_fingerprint'").get();
  assert.ok(index);
  assert.doesNotMatch(index.sql || "", /UNIQUE/i);
});

test("migration 7: enforces cross-user ledger, achievement, and duplicate ownership", () => {
  assert.throws(() => db.prepare(`INSERT INTO score_events
    (event_key,user_id,watch_id,category,points,rule_version) VALUES ('test/cross-watch',1,5,'test',1,'test-v1')`).run(), /owner mismatch/i);

  const bobAchievementEvent = db.prepare("SELECT id FROM score_events WHERE achievement_id=2").get().id;
  assert.throws(() => db.prepare("UPDATE achievements SET score_event_id=? WHERE id=1").run(bobAchievementEvent), /achievement score event mismatch/i);

  db.exec("SAVEPOINT achievement_owner_test");
  try {
    db.prepare("UPDATE achievements SET score_event_id=NULL WHERE id=1").run();
    assert.throws(() => db.prepare("UPDATE achievements SET user_id=2 WHERE id=1").run(), /achievement score event mismatch/i);
  } finally {
    db.exec("ROLLBACK TO achievement_owner_test; RELEASE achievement_owner_test");
  }

  assert.throws(() => db.prepare(`INSERT INTO duplicate_cases
    (user_id,fingerprint,canonical_watch_id,candidate_watch_id) VALUES (1,'cross-user',1,5)`).run(), /owner mismatch/i);

  db.prepare(`INSERT INTO duplicate_cases
    (user_id,fingerprint,canonical_watch_id,candidate_watch_id) VALUES (1,'same-user',1,2)`).run();
  assert.throws(() => db.prepare("UPDATE watches SET user_id=2 WHERE id=2").run(), /dependent competitive records/i);

  const watchEvent = db.prepare("SELECT id FROM score_events WHERE watch_id=1").get().id;
  assert.throws(() => db.prepare("UPDATE score_events SET user_id=2 WHERE id=?").run(watchEvent), /owner mismatch/i);
});

test("migration 7: backfills UTC chronology and eligibility from stored history", () => {
  const rows = db.prepare(`SELECT id, watched_at_utc, watched_day_local, timezone_used, qualifies_for_volume, qualifies_for_achievement, qualifies_for_streak, qualifies_for_season, eligibility_status, eligibility_rule_version, eligibility_reason, logical_canonical_watch_id FROM watches ORDER BY id`).all();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { id: 1, watched_at_utc: "2024-01-10T20:00:00.000Z", watched_day_local: "2024-01-10", timezone_used: "UTC", qualifies_for_volume: 1, qualifies_for_achievement: 1, qualifies_for_streak: 1, qualifies_for_season: 1, eligibility_status: "legacy_assumed", eligibility_rule_version: "competition-v1-backfill", eligibility_reason: "legacy_canonical_first_watch", logical_canonical_watch_id: 1 });
  assert.deepEqual(rows.slice(2, 4).map((row) => [row.qualifies_for_volume, row.qualifies_for_achievement, row.qualifies_for_streak, row.qualifies_for_season, row.eligibility_status, row.eligibility_rule_version, row.logical_canonical_watch_id]), [
    [0, 0, 0, 0, "legacy_assumed", "competition-v1-backfill", 1],
    [0, 0, 1, 1, "legacy_assumed", "competition-v1-backfill", 1],
  ]);
});

test("migration 7: legacy ledger backfill preserves exact totals without duplication", () => {
  const originalTotal = 50 + 45 + 0 + 10 + 60 + 55 + 100 + 50;
  const ledger = db.prepare("SELECT * FROM score_events ORDER BY id").all();
  assert.equal(ledger.length, 8);
  assert.equal(ledger.reduce((sum, row) => sum + row.points, 0), originalTotal);
  assert.deepEqual(db.prepare("SELECT user_id, SUM(points) total FROM score_events GROUP BY user_id ORDER BY user_id").all(), [
    { user_id: 1, total: 205 },
    { user_id: 2, total: 165 },
  ]);
  assert.ok(ledger.every((row) => row.rule_version === "legacy-v1"));
  assert.equal(new Set(ledger.filter((row) => row.watch_id).map((row) => row.watch_id)).size, 6);
  assert.equal(new Set(ledger.filter((row) => row.achievement_id).map((row) => row.achievement_id)).size, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM achievements WHERE score_event_id IS NOT NULL").get().c, 2);
  const watchMetadata = ledger.filter((row) => row.watch_id).map((row) => JSON.parse(row.metadata_json));
  assert.ok(watchMetadata.every((meta) => meta.backfilled === true && Object.hasOwn(meta, "is_rewatch")));
  assert.equal(db.prepare("SELECT points FROM score_events WHERE watch_id=3").get().points, 0);
  assert.ok(ledger.every((row) => row.event_key.startsWith("legacy/")));
  runMigrations({ skipBackup: true });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events").get().c, 8);
  assert.equal(db.prepare("SELECT SUM(points) s FROM score_events").get().s, originalTotal);
});

test("backup includes committed WAL rows when a reader prevents checkpointing", async () => {
  const reader = new Database(DB_PATH);
  reader.pragma("journal_mode = WAL");
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM users").get();

  const marker = `wal_${process.pid}`;
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'marker')").run(marker);
  const checkpoint = db.pragma("wal_checkpoint(FULL)")[0];
  assert.ok(checkpoint.busy > 0, "reader keeps committed data in WAL");

  const backup = createBackup();
  const bdb = new Database(backup.path, { readonly: true });
  assert.ok(bdb.prepare("SELECT id FROM users WHERE username = ?").get(marker), "backup contains committed WAL row");
  assert.equal(bdb.pragma("integrity_check")[0].integrity_check, "ok");
  bdb.close();

  reader.exec("ROLLBACK");
  reader.close();
  db.prepare("DELETE FROM users WHERE username = ?").run(marker);
});
