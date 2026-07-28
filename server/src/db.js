import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "reelscore.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnExists(table, column) {
  return (
    db
      .prepare(`SELECT COUNT(*) c FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column).c > 0
  );
}

function indexExists(name) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?`
      )
      .get(name).c > 0
  );
}

export function tableExists(name) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?`
      )
      .get(name).c > 0
  );
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export function createBackup() {
  const backupsDir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });

  // Timestamp: 20260728T024834Z
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
    .replace("T", "T");
  const backupPath = path.join(backupsDir, `reelscore-pre-hosted-${ts}.db`);

  // Checkpoint WAL so the DB file contains all committed data.
  db.pragma("wal_checkpoint(FULL)");

  try {
    fs.copyFileSync(DB_PATH, backupPath);
  } catch {
    // DB file doesn't exist yet (fresh install) — no backup needed.
    return { path: null, ok: false };
  }

  // Integrity-check the backup.
  const bdb = new Database(backupPath, { readonly: true });
  const check = bdb.pragma("integrity_check");
  bdb.close();

  const ok =
    Array.isArray(check) &&
    check.length > 0 &&
    check[0]?.integrity_check === "ok";

  return { path: backupPath, ok };
}

// ---------------------------------------------------------------------------
// Migration 0 — core legacy schema (CREATE IF NOT EXISTS; always idempotent)
// ---------------------------------------------------------------------------

function migration0() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      public_profile INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id, watched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_watches_user_movie ON watches(user_id, tmdb_id);

    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      points INTEGER NOT NULL DEFAULT 0,
      unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS connections (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      server_url TEXT,
      service_username TEXT,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at TEXT,
      PRIMARY KEY (user_id, service)
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, friend_id)
    );
  `);
}

// ---------------------------------------------------------------------------
// Migration 1 — roles / sessions / invites / audit / provider_event_id
// ---------------------------------------------------------------------------

function migration1() {
  if (!columnExists("users", "role")) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  }
  if (!columnExists("users", "status")) {
    db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      user_agent TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT UNIQUE NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      email TEXT,
      used_by INTEGER REFERENCES users(id),
      used_at TEXT,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target_id INTEGER,
      detail TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  if (!columnExists("watches", "provider_event_id")) {
    db.exec(`ALTER TABLE watches ADD COLUMN provider_event_id TEXT`);
  }
  if (!indexExists("idx_watches_event")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_event
        ON watches(user_id, provider_event_id)
        WHERE provider_event_id IS NOT NULL
    `);
  }

  // Admin bootstrap: make the oldest user admin if no admin exists yet.
  const adminCount = db
    .prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'")
    .get().c;
  if (adminCount === 0) {
    const oldest = db
      .prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1")
      .get();
    if (oldest) {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(oldest.id);
    }
  }

  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (1)").run();
}

// ---------------------------------------------------------------------------
// Public: run all pending migrations
// ---------------------------------------------------------------------------

export function runMigrations({ skipBackup = false } = {}) {
  const wasLegacy = !tableExists("schema_versions");

  // For a non-empty legacy DB, create a backup before altering schema.
  let backup = null;
  if (wasLegacy && !skipBackup) {
    const userCount = tableExists("users")
      ? db.prepare("SELECT COUNT(*) c FROM users").get().c
      : 0;
    if (userCount > 0) {
      backup = createBackup();
      if (!backup.ok) {
        throw new Error("[reelscore] Refusing to migrate: pre-migration backup failed integrity check.");
      }
    }
  }

  // Only after the verified backup exists, ensure the base legacy tables exist.
  migration0();

  const applied = tableExists("schema_versions")
    ? new Set(
        db
          .prepare("SELECT version FROM schema_versions")
          .all()
          .map((r) => r.version)
      )
    : new Set();

  if (!applied.has(1)) {
    migration1();
  }

  return { backup };
}

// Run migrations automatically on module load.
runMigrations();

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function totalScore(userId) {
  const w = db
    .prepare("SELECT COALESCE(SUM(points),0) s FROM watches WHERE user_id = ?")
    .get(userId).s;
  const a = db
    .prepare(
      "SELECT COALESCE(SUM(points),0) s FROM achievements WHERE user_id = ?"
    )
    .get(userId).s;
  return w + a;
}

export function watchCount(userId) {
  return db
    .prepare("SELECT COUNT(*) c FROM watches WHERE user_id = ?")
    .get(userId).c;
}

export function currentStreak(userId) {
  const rows = db
    .prepare(
      "SELECT DISTINCT date(watched_at) d FROM watches WHERE user_id = ? ORDER BY d DESC LIMIT 400"
    )
    .all(userId)
    .map((r) => r.d);
  if (rows.length === 0) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (rows[0] !== today && rows[0] !== yesterday) return 0;
  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1] + "T00:00:00Z").getTime();
    const cur = new Date(rows[i] + "T00:00:00Z").getTime();
    if (prev - cur === 86400000) streak++;
    else break;
  }
  return streak;
}
