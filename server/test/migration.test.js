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

  // 2 watches for alice (id=1), 2 for bob (id=2).
  legacy.prepare(`
    INSERT INTO watches (user_id, tmdb_id, title, points, watched_at) VALUES
    (1, 1000, 'Film A', 50, '2024-01-10 20:00:00'),
    (1, 1001, 'Film B', 45, '2024-01-15 20:00:00'),
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

const { db, runMigrations, tableExists, DATA_DIR: DD } = await import("../src/db.js");

test("migration: original users are preserved", () => {
  const users = db.prepare("SELECT * FROM users ORDER BY id").all();
  assert.equal(users.length, 2);
  assert.equal(users[0].username, "alice");
  assert.equal(users[1].username, "bob");
  // Password hashes untouched.
  assert.equal(users[0].password_hash, "$2a$10$legacyhash1");
  assert.equal(users[1].password_hash, "$2a$10$legacyhash2");
});

test("migration: watches are preserved (4 rows)", () => {
  const count = db.prepare("SELECT COUNT(*) c FROM watches").get().c;
  assert.equal(count, 4);
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

test("migration: watches have provider_event_id column", () => {
  const info = db.prepare("PRAGMA table_info(watches)").all();
  assert.ok(
    info.some((c) => c.name === "provider_event_id"),
    "provider_event_id column exists"
  );
});
