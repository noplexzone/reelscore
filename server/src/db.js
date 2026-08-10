import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { evaluateWatchEligibility } from "./eligibility.js";
import { localDay, normalizeUtcInstant } from "./time.js";

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

export function initializeDatabase({ targetVersion = 8 } = {}) {
  const instance = openDatabase();
  if (!initialized && !initializing) {
    initializing = true;
    try {
      runMigrations({ targetVersion });
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

// Optional TOTP MFA, individually one-use recovery codes, login challenges,
// and opaque public identifiers for user-facing session management.
function migration6() {
  if (!columnExists("users", "totp_pending_encrypted")) db.exec(`ALTER TABLE users ADD COLUMN totp_pending_encrypted TEXT`);
  if (!columnExists("users", "totp_secret_encrypted")) db.exec(`ALTER TABLE users ADD COLUMN totp_secret_encrypted TEXT`);
  if (!columnExists("users", "mfa_enabled_at")) db.exec(`ALTER TABLE users ADD COLUMN mfa_enabled_at INTEGER`);
  if (!columnExists("sessions", "public_id")) db.exec(`ALTER TABLE sessions ADD COLUMN public_id TEXT`);
  db.exec(`
    UPDATE sessions SET public_id=lower(hex(randomblob(16))) WHERE public_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id ON sessions(public_id);

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_digest TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user
      ON mfa_recovery_codes(user_id, used_at);

    CREATE TABLE IF NOT EXISTS mfa_login_challenges (
      challenge_digest TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_challenge_user
      ON mfa_login_challenges(user_id, consumed_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_mfa_challenge_expiry
      ON mfa_login_challenges(expires_at);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (6)").run();
}

// Competitive-integrity event fields and append-oriented score ledger.
function migration7() {
  const legacyTotals = db.prepare(`
    SELECT u.id user_id,
      COALESCE((SELECT SUM(points) FROM watches WHERE user_id=u.id),0) +
      COALESCE((SELECT SUM(points) FROM achievements WHERE user_id=u.id),0) total
    FROM users u ORDER BY u.id
  `).all();

  if (!columnExists("users", "timezone")) db.exec(`ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);

  const watchColumns = [
    ["watched_at_utc", "TEXT"],
    ["watched_day_local", "TEXT"],
    ["timezone_used", "TEXT"],
    ["qualifies_for_volume", "INTEGER NOT NULL DEFAULT 0 CHECK(qualifies_for_volume IN (0,1))"],
    ["qualifies_for_achievement", "INTEGER NOT NULL DEFAULT 0 CHECK(qualifies_for_achievement IN (0,1))"],
    ["qualifies_for_streak", "INTEGER NOT NULL DEFAULT 0 CHECK(qualifies_for_streak IN (0,1))"],
    ["qualifies_for_season", "INTEGER NOT NULL DEFAULT 0 CHECK(qualifies_for_season IN (0,1))"],
    ["eligibility_status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["eligibility_rule_version", "TEXT"],
    ["eligibility_reason", "TEXT"],
    ["deleted_at", "TEXT"],
    ["deleted_reason", "TEXT"],
    ["logical_canonical_watch_id", "INTEGER REFERENCES watches(id)"],
  ];
  for (const [name, definition] of watchColumns) {
    if (!columnExists("watches", name)) db.exec(`ALTER TABLE watches ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS score_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      watch_id INTEGER REFERENCES watches(id) ON DELETE RESTRICT,
      achievement_id INTEGER REFERENCES achievements(id) ON DELETE RESTRICT,
      season_id INTEGER,
      category TEXT NOT NULL,
      points INTEGER NOT NULL,
      rule_version TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reversed_at TEXT,
      reverses_event_id INTEGER UNIQUE REFERENCES score_events(id) ON DELETE RESTRICT,
      CHECK((watch_id IS NOT NULL) + (achievement_id IS NOT NULL) <= 1)
    );
    CREATE INDEX IF NOT EXISTS idx_score_events_user_chronology
      ON score_events(user_id, season_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_score_events_watch ON score_events(watch_id, id);
    CREATE INDEX IF NOT EXISTS idx_score_events_achievement ON score_events(achievement_id, id);
    CREATE INDEX IF NOT EXISTS idx_watches_competitive_timeline
      ON watches(user_id, tmdb_id, watched_at_utc, id);
    CREATE INDEX IF NOT EXISTS idx_watches_streak_day
      ON watches(user_id, watched_day_local) WHERE deleted_at IS NULL AND qualifies_for_streak=1;

    CREATE TABLE IF NOT EXISTS duplicate_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      canonical_watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE RESTRICT,
      candidate_watch_id INTEGER NOT NULL UNIQUE REFERENCES watches(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
      resolution TEXT CHECK(resolution IN ('merge','keep_both','keep_separate','ignore_future_matching')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      CHECK(canonical_watch_id <> candidate_watch_id),
      CHECK((status='pending' AND resolution IS NULL AND resolved_at IS NULL) OR
            (status='resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_duplicate_cases_user_status
      ON duplicate_cases(user_id, status, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_cases_pending_fingerprint
      ON duplicate_cases(user_id, fingerprint) WHERE status='pending';

    CREATE TABLE IF NOT EXISTS duplicate_ignore_rules (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(user_id, fingerprint)
    );
  `);

  if (!columnExists("achievements", "score_event_id")) db.exec(`ALTER TABLE achievements ADD COLUMN score_event_id INTEGER REFERENCES score_events(id)`);
  if (!columnExists("achievements", "revoked_at")) db.exec(`ALTER TABLE achievements ADD COLUMN revoked_at TEXT`);
  if (!columnExists("achievements", "revocation_reason")) db.exec(`ALTER TABLE achievements ADD COLUMN revocation_reason TEXT`);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_score_events_owner_insert
    BEFORE INSERT ON score_events
    WHEN (NEW.watch_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM watches w WHERE w.id=NEW.watch_id AND w.user_id=NEW.user_id
          ))
      OR (NEW.achievement_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM achievements a WHERE a.id=NEW.achievement_id AND a.user_id=NEW.user_id
          ))
    BEGIN
      SELECT RAISE(ABORT, 'score event source owner mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_owner_update
    BEFORE UPDATE OF user_id,watch_id,achievement_id ON score_events
    WHEN (NEW.watch_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM watches w WHERE w.id=NEW.watch_id AND w.user_id=NEW.user_id
          ))
      OR (NEW.achievement_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM achievements a WHERE a.id=NEW.achievement_id AND a.user_id=NEW.user_id
          ))
      OR EXISTS (
            SELECT 1 FROM achievements a WHERE a.score_event_id=OLD.id
              AND (NEW.achievement_id IS NULL OR a.id<>NEW.achievement_id OR a.user_id<>NEW.user_id)
          )
    BEGIN
      SELECT RAISE(ABORT, 'score event source owner mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_achievements_score_event_insert
    BEFORE INSERT ON achievements
    WHEN NEW.score_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM score_events s WHERE s.id=NEW.score_event_id
        AND s.achievement_id=NEW.id AND s.user_id=NEW.user_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'achievement score event mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_achievements_score_event_update
    BEFORE UPDATE OF score_event_id,user_id,id ON achievements
    WHEN (NEW.score_event_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM score_events s WHERE s.id=NEW.score_event_id
              AND s.achievement_id=NEW.id AND s.user_id=NEW.user_id
          ))
      OR EXISTS (
            SELECT 1 FROM score_events s WHERE s.achievement_id=OLD.id
              AND (s.achievement_id<>NEW.id OR s.user_id<>NEW.user_id)
          )
    BEGIN
      SELECT RAISE(ABORT, 'achievement score event mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_duplicate_cases_owner_insert
    BEFORE INSERT ON duplicate_cases
    WHEN NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.canonical_watch_id AND w.user_id=NEW.user_id)
      OR NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.candidate_watch_id AND w.user_id=NEW.user_id)
    BEGIN
      SELECT RAISE(ABORT, 'duplicate case owner mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_duplicate_cases_owner_update
    BEFORE UPDATE OF user_id,canonical_watch_id,candidate_watch_id ON duplicate_cases
    WHEN NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.canonical_watch_id AND w.user_id=NEW.user_id)
      OR NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.candidate_watch_id AND w.user_id=NEW.user_id)
    BEGIN
      SELECT RAISE(ABORT, 'duplicate case owner mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_watches_owner_update
    BEFORE UPDATE OF user_id ON watches
    WHEN EXISTS (SELECT 1 FROM score_events s WHERE s.watch_id=OLD.id AND s.user_id<>NEW.user_id)
      OR EXISTS (SELECT 1 FROM duplicate_cases d
        WHERE (d.canonical_watch_id=OLD.id OR d.candidate_watch_id=OLD.id) AND d.user_id<>NEW.user_id)
    BEGIN
      SELECT RAISE(ABORT, 'watch owner has dependent competitive records');
    END;
  `);

  const watches = db.prepare(`SELECT id,user_id,tmdb_id,watched_at,watched_at_utc,points,is_rewatch,deleted_at
    FROM watches ORDER BY watched_at,id`).all();
  const updateTime = db.prepare("UPDATE watches SET watched_at_utc=?, watched_day_local=?, timezone_used='UTC' WHERE id=?");
  for (const watch of watches) {
    const instant = normalizeUtcInstant(watch.watched_at_utc || watch.watched_at);
    updateTime.run(instant, localDay(instant, "UTC"), watch.id);
    watch.watched_at_utc = instant;
  }

  const updateEligibility = db.prepare(`UPDATE watches SET logical_canonical_watch_id=?, qualifies_for_volume=?,
    qualifies_for_achievement=?, qualifies_for_streak=?, qualifies_for_season=?, eligibility_status='legacy_assumed',
    eligibility_rule_version='competition-v1-backfill', eligibility_reason=? WHERE id=?`);
  for (const decision of evaluateWatchEligibility(watches)) {
    updateEligibility.run(
      decision.logical_canonical_watch_id,
      decision.qualifies_for_volume,
      decision.qualifies_for_achievement,
      decision.qualifies_for_streak,
      decision.qualifies_for_season,
      `legacy_${decision.eligibility_reason}`,
      decision.id,
    );
  }

  const insertLegacyWatch = db.prepare(`INSERT OR IGNORE INTO score_events
    (event_key,user_id,watch_id,category,points,rule_version,metadata_json,created_at)
    SELECT 'legacy/watch/'||id,user_id,id,'legacy_watch',points,'legacy-v1',
      json_object('title',title,'tmdb_id',tmdb_id,'vote_average',vote_average,'runtime',runtime,
        'source',source,'watched_at_utc',watched_at_utc,'stored_points',points,'is_rewatch',is_rewatch,'backfilled',json('true')),
      watched_at_utc FROM watches WHERE id=?`);
  for (const watch of watches) insertLegacyWatch.run(watch.id);

  db.exec(`
    INSERT OR IGNORE INTO score_events
      (event_key,user_id,achievement_id,category,points,rule_version,metadata_json,created_at)
      SELECT 'legacy/achievement/'||id,user_id,id,'legacy_achievement',points,'legacy-v1',
        json_object('key',key,'name',name,'stored_points',points,'backfilled',json('true')),unlocked_at
      FROM achievements;
    UPDATE achievements SET score_event_id=(SELECT id FROM score_events
      WHERE achievement_id=achievements.id AND event_key='legacy/achievement/'||achievements.id)
      WHERE score_event_id IS NULL;
  `);

  for (const expected of legacyTotals) {
    const actual = db.prepare("SELECT COALESCE(SUM(points),0) total FROM score_events WHERE user_id=?").get(expected.user_id).total;
    if (actual !== expected.total) throw new Error(`[reelscore] Migration 7 ledger parity failed for user ${expected.user_id}.`);
  }
  const invalidWatchEvents = db.prepare(`SELECT COUNT(*) c FROM watches w
    LEFT JOIN score_events s ON s.event_key='legacy/watch/'||w.id AND s.watch_id=w.id
      AND s.user_id=w.user_id AND s.category='legacy_watch' AND s.rule_version='legacy-v1'
    WHERE s.id IS NULL OR s.points<>w.points`).get().c;
  const invalidAchievementEvents = db.prepare(`SELECT COUNT(*) c FROM achievements a
    LEFT JOIN score_events s ON s.event_key='legacy/achievement/'||a.id AND s.achievement_id=a.id
      AND s.user_id=a.user_id AND s.category='legacy_achievement' AND s.rule_version='legacy-v1'
    WHERE s.id IS NULL OR s.points<>a.points`).get().c;
  const legacyWatchEvents = db.prepare("SELECT COUNT(*) c FROM score_events WHERE event_key LIKE 'legacy/watch/%'").get().c;
  const legacyAchievementEvents = db.prepare("SELECT COUNT(*) c FROM score_events WHERE event_key LIKE 'legacy/achievement/%'").get().c;
  const watchCount = db.prepare("SELECT COUNT(*) c FROM watches").get().c;
  const achievementCount = db.prepare("SELECT COUNT(*) c FROM achievements").get().c;
  if (invalidWatchEvents !== 0 || invalidAchievementEvents !== 0 ||
      legacyWatchEvents !== watchCount || legacyAchievementEvents !== achievementCount) {
    throw new Error("[reelscore] Migration 7 source-exact legacy event check failed.");
  }
  const incomplete = db.prepare(`SELECT COUNT(*) c FROM watches WHERE watched_at_utc IS NULL OR watched_day_local IS NULL
    OR timezone_used IS NULL OR eligibility_status<>'legacy_assumed' OR eligibility_rule_version IS NULL
    OR eligibility_reason IS NULL OR logical_canonical_watch_id IS NULL`).get().c;
  if (incomplete !== 0) throw new Error("[reelscore] Migration 7 watch backfill completeness check failed.");

  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (7)").run();
}


function migration8() {
  if (!columnExists("duplicate_cases", "cancelled_at")) db.exec("ALTER TABLE duplicate_cases ADD COLUMN cancelled_at TEXT");
  if (!columnExists("duplicate_cases", "cancellation_reason")) db.exec("ALTER TABLE duplicate_cases ADD COLUMN cancellation_reason TEXT");
  db.exec(`
    DROP INDEX IF EXISTS idx_duplicate_cases_pending_fingerprint;
    CREATE INDEX IF NOT EXISTS idx_duplicate_cases_fingerprint ON duplicate_cases(user_id,fingerprint,status,id);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (8)").run();
}

// ---------------------------------------------------------------------------
// Public: run all pending migrations
// ---------------------------------------------------------------------------

export function runMigrations({ skipBackup = false, targetVersion = 8 } = {}) {
  const latestVersion = 8;
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > latestVersion) {
    throw new RangeError(`Invalid migration target version: ${targetVersion}`);
  }
  const appliedBefore = tableExists("schema_versions")
    ? new Set(db.prepare("SELECT version FROM schema_versions").all().map((row) => row.version))
    : new Set();
  const highestVersion = appliedBefore.size ? Math.max(...appliedBefore) : 0;
  if (highestVersion > latestVersion) {
    throw new Error(`[reelscore] Database schema version ${highestVersion} is newer than this build supports (${latestVersion}).`);
  }
  const hasPendingMigration = Array.from({ length: targetVersion }, (_, index) => index + 1).some((version) => !appliedBefore.has(version));

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

  if (targetVersion >= 1 && !applied.has(1)) {
    db.transaction(migration1)();
  }
  if (targetVersion >= 2 && !applied.has(2)) {
    db.transaction(migration2)();
  }
  if (targetVersion >= 3 && !applied.has(3)) {
    db.transaction(migration3)();
  }
  if (targetVersion >= 4 && !applied.has(4)) {
    db.transaction(migration4)();
  }
  if (targetVersion >= 5 && !applied.has(5)) {
    db.transaction(migration5)();
  }
  if (targetVersion >= 6 && !applied.has(6)) {
    db.transaction(migration6)();
  }
  if (targetVersion >= 7 && !applied.has(7)) {
    db.transaction(migration7)();
  }
  if (targetVersion >= 8 && !applied.has(8)) {
    db.transaction(migration8)();
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

export function totalScore(userId, { seasonId = null } = {}) {
  return db.prepare("SELECT COALESCE(SUM(points),0) s FROM score_events WHERE user_id=? AND season_id IS ?")
    .get(userId, seasonId).s;
}

export function watchCount(userId) {
  return db
    .prepare("SELECT COUNT(*) c FROM watches WHERE user_id = ? AND deleted_at IS NULL")
    .get(userId).c;
}
