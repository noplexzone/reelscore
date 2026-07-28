import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "reelscore.db");
let rawDb = null;
let initialized = false;
let initializing = false;

function openDatabase() {
  if (!rawDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    rawDb = new Database(DB_PATH);
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");
  }
  return rawDb;
}

export function initializeDatabase() {
  const instance = openDatabase();
  if (!initialized && !initializing) {
    initializing = true;
    try {
      runMigrations();
      initialized = true;
    } finally {
      initializing = false;
    }
  }
  return instance;
}

// Existing modules retain the db API, while opening and migration remain lazy
// until config.js has validated the complete environment.
export const db = new Proxy({}, {
  get(_target, property) {
    const instance = initializing ? openDatabase() : initializeDatabase();
    const value = instance[property];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

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
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "");
  const backupPath = path.join(backupsDir, `reelscore-pre-hosted-${ts}.db`);

  try {
    // VACUUM INTO is a transactionally consistent SQLite snapshot. Unlike a
    // filesystem copy, it includes committed WAL frames even when another
    // connection prevents checkpointing.
    db.prepare("VACUUM INTO ?").run(backupPath);
    fs.chmodSync(backupPath, 0o600);

    const sourceCheck = db.pragma("integrity_check");
    const bdb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const backupCheck = bdb.pragma("integrity_check");
    bdb.close();
    const sourceOk = sourceCheck?.[0]?.integrity_check === "ok";
    const backupOk = backupCheck?.[0]?.integrity_check === "ok";
    if (!sourceOk || !backupOk) throw new Error("SQLite integrity check failed.");
    return { path: backupPath, ok: true };
  } catch (error) {
    try { fs.rmSync(backupPath, { force: true }); } catch {}
    throw new Error(`[reelscore] Pre-migration backup failed: ${error.message}`);
  }
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

// Provider identities, encrypted connections, and one-use provider flows.
function migration2() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK(provider IN ('plex','trakt')),
      provider_user_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_user_id),
      UNIQUE(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS provider_flows (
      state_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('plex','trakt')),
      action TEXT NOT NULL CHECK(action IN ('login','link')),
      session_hash TEXT,
      browser_hash TEXT NOT NULL,
      invite_hash TEXT,
      remote_id TEXT,
      secret_encrypted TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_flows_expires ON provider_flows(expires_at);
  `);
  if (!columnExists("connections", "credentials_encrypted")) db.exec(`ALTER TABLE connections ADD COLUMN credentials_encrypted TEXT`);
  if (!columnExists("connections", "provider_identity_id")) db.exec(`ALTER TABLE connections ADD COLUMN provider_identity_id INTEGER REFERENCES provider_identities(id)`);
  if (!columnExists("connections", "server_machine_id")) db.exec(`ALTER TABLE connections ADD COLUMN server_machine_id TEXT`);
  if (!columnExists("connections", "token_expires_at")) db.exec(`ALTER TABLE connections ADD COLUMN token_expires_at TEXT`);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (2)").run();
}

// Event-scoped provider identity and one-use reconciliation previews.
function migration3() {
  if (!columnExists("watches", "provider_service")) db.exec(`ALTER TABLE watches ADD COLUMN provider_service TEXT`);
  if (!columnExists("watches", "provider_connection_id")) db.exec(`ALTER TABLE watches ADD COLUMN provider_connection_id TEXT`);
  db.exec(`
    DROP INDEX IF EXISTS idx_watches_event;
    CREATE UNIQUE INDEX idx_watches_event
      ON watches(user_id, provider_service, provider_connection_id, provider_event_id)
      WHERE provider_event_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS reconciliation_previews (
      nonce_hash TEXT PRIMARY KEY,
      preview_hash TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      target_user_id INTEGER NOT NULL REFERENCES users(id),
      placeholder_date TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reconciliation_previews_expiry
      ON reconciliation_previews(expires_at);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (3)").run();
}

function migration4() {
  if (!columnExists("sessions", "last_seen_at")) db.exec(`ALTER TABLE sessions ADD COLUMN last_seen_at TEXT`);
  db.exec(`
    UPDATE sessions SET last_seen_at=COALESCE(last_seen_at,created_at);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (4)").run();
}

// Verified local identity, one-use account tokens, and encrypted email outbox.
function migration5() {
  if (!columnExists("users", "email")) db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  if (!columnExists("users", "email_normalized")) db.exec(`ALTER TABLE users ADD COLUMN email_normalized TEXT`);
  if (!columnExists("users", "email_verified_at")) db.exec(`ALTER TABLE users ADD COLUMN email_verified_at INTEGER`);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_users_email_identity_insert
    BEFORE INSERT ON users
    WHEN (NEW.email IS NULL AND NEW.email_normalized IS NOT NULL)
      OR (NEW.email IS NOT NULL AND NEW.email_normalized IS NULL)
      OR (NEW.email IS NOT NULL AND NEW.email_normalized <> lower(trim(NEW.email)))
    BEGIN
      SELECT RAISE(ABORT, 'email normalization invariant failed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_users_email_identity_update
    BEFORE UPDATE OF email, email_normalized ON users
    WHEN (NEW.email IS NULL AND NEW.email_normalized IS NOT NULL)
      OR (NEW.email IS NOT NULL AND NEW.email_normalized IS NULL)
      OR (NEW.email IS NOT NULL AND NEW.email_normalized <> lower(trim(NEW.email)))
    BEGIN
      SELECT RAISE(ABORT, 'email normalization invariant failed');
    END;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized
      ON users(email_normalized)
      WHERE email_normalized IS NOT NULL;

    CREATE TABLE IF NOT EXISTS account_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','password_reset')),
      token_digest TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_tokens_user_purpose
      ON account_tokens(user_id, purpose, consumed_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_account_tokens_expiry
      ON account_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS email_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('queued','sending','accepted','delivered','failed','dead')),
      priority INTEGER NOT NULL DEFAULT 100,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      provider_message_id TEXT,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_email_jobs_due
      ON email_jobs(state, priority, next_attempt_at, id);
    CREATE INDEX IF NOT EXISTS idx_email_jobs_user
      ON email_jobs(user_id, created_at DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (5)").run();
}

// ---------------------------------------------------------------------------
// Public: run all pending migrations
// ---------------------------------------------------------------------------

export function runMigrations({ skipBackup = false } = {}) {
  const latestVersion = 5;
  const appliedBefore = tableExists("schema_versions")
    ? new Set(db.prepare("SELECT version FROM schema_versions").all().map((row) => row.version))
    : new Set();
  const highestVersion = appliedBefore.size ? Math.max(...appliedBefore) : 0;
  if (highestVersion > latestVersion) {
    throw new Error(`[reelscore] Database schema version ${highestVersion} is newer than this build supports (${latestVersion}).`);
  }
  const hasPendingMigration = [1, 2, 3, 4, 5].some((version) => !appliedBefore.has(version));

  // Back up any non-empty database before every pending schema migration,
  // including upgrades between versioned schemas.
  let backup = null;
  if (hasPendingMigration && !skipBackup) {
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
    db.transaction(migration1)();
  }
  if (!applied.has(2)) {
    db.transaction(migration2)();
  }
  if (!applied.has(3)) {
    db.transaction(migration3)();
  }
  if (!applied.has(4)) {
    db.transaction(migration4)();
  }
  if (!applied.has(5)) {
    db.transaction(migration5)();
  }

  if (process.env.APP_MODE === "hosted") {
    const plaintext = db.prepare(`SELECT COUNT(*) c FROM connections
      WHERE credentials_encrypted IS NULL
        AND (access_token IS NOT NULL OR refresh_token IS NOT NULL)`).get().c;
    if (plaintext > 0) {
      throw new Error("[reelscore] Hosted startup refused: plaintext provider credentials exist. Start in self_hosted mode and re-link those providers first.");
    }
  }

  return { backup };
}


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
