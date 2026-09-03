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

export function initializeDatabase({ targetVersion = 15 } = {}) {
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


// Private leagues, immutable membership tenures, and season score ownership.
function migration9() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leagues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
      timezone TEXT NOT NULL CHECK(length(trim(timezone)) BETWEEN 1 AND 64),
      default_mode TEXT NOT NULL DEFAULT 'casual' CHECK(default_mode IN ('casual','verified','challenge')),
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      archived_at TEXT CHECK(archived_at IS NULL OR (archived_at GLOB '????-??-??T??:??:??.???Z' AND julianday(archived_at) IS NOT NULL)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(updated_at GLOB '????-??-??T??:??:??.???Z' AND julianday(updated_at) IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS league_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      joined_at TEXT NOT NULL CHECK(joined_at GLOB '????-??-??T??:??:??.???Z' AND julianday(joined_at) IS NOT NULL),
      left_at TEXT CHECK(left_at IS NULL OR (left_at GLOB '????-??-??T??:??:??.???Z' AND julianday(left_at) IS NOT NULL)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
      UNIQUE(league_id,user_id,joined_at),
      CHECK(left_at IS NULL OR left_at > joined_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_league_memberships_active
      ON league_memberships(league_id,user_id) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_league_memberships_user_active
      ON league_memberships(user_id,league_id) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_league_memberships_tenure
      ON league_memberships(league_id,user_id,joined_at,left_at,id);

    CREATE TABLE IF NOT EXISTS league_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) BETWEEN 16 AND 256),
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 1000),
      expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(expires_at) IS NOT NULL),
      revoked_at TEXT CHECK(revoked_at IS NULL OR (revoked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(revoked_at) IS NOT NULL)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_league_invites_league_active
      ON league_invites(league_id,expires_at,id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_league_invites_token ON league_invites(token_hash);

    CREATE TABLE IF NOT EXISTS league_invite_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_id INTEGER NOT NULL REFERENCES league_invites(id) ON DELETE RESTRICT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      membership_id INTEGER NOT NULL REFERENCES league_memberships(id) ON DELETE RESTRICT,
      used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(used_at GLOB '????-??-??T??:??:??.???Z' AND julianday(used_at) IS NOT NULL),
      UNIQUE(invite_id,user_id),
      UNIQUE(invite_id,membership_id)
    );
    CREATE INDEX IF NOT EXISTS idx_league_invite_uses_invite ON league_invite_uses(invite_id,used_at,id);
    CREATE INDEX IF NOT EXISTS idx_league_invite_uses_user ON league_invite_uses(user_id,used_at,id);

    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
      mode TEXT NOT NULL CHECK(mode IN ('casual','verified','challenge')),
      timezone TEXT NOT NULL CHECK(length(trim(timezone)) BETWEEN 1 AND 64),
      rule_version TEXT NOT NULL CHECK(length(trim(rule_version)) BETWEEN 1 AND 64),
      starts_at TEXT NOT NULL CHECK(starts_at GLOB '????-??-??T??:??:??.???Z' AND julianday(starts_at) IS NOT NULL),
      ends_at TEXT NOT NULL CHECK(ends_at GLOB '????-??-??T??:??:??.???Z' AND julianday(ends_at) IS NOT NULL),
      cancelled_at TEXT CHECK(cancelled_at IS NULL OR (cancelled_at GLOB '????-??-??T??:??:??.???Z' AND julianday(cancelled_at) IS NOT NULL)),
      finalized_at TEXT CHECK(finalized_at IS NULL OR (finalized_at GLOB '????-??-??T??:??:??.???Z' AND julianday(finalized_at) IS NOT NULL)),
      participants_locked_at TEXT CHECK(participants_locked_at IS NULL OR (participants_locked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(participants_locked_at) IS NOT NULL)),
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(updated_at GLOB '????-??-??T??:??:??.???Z' AND julianday(updated_at) IS NOT NULL),
      CHECK(starts_at < ends_at),
      CHECK(cancelled_at IS NULL OR finalized_at IS NULL),
      CHECK(finalized_at IS NULL OR finalized_at >= ends_at)
    );
    CREATE INDEX IF NOT EXISTS idx_seasons_league_chronology
      ON seasons(league_id,starts_at,ends_at,id) WHERE cancelled_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_seasons_lifecycle ON seasons(ends_at,finalized_at,cancelled_at,id);

    CREATE TABLE IF NOT EXISTS season_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      membership_id INTEGER NOT NULL REFERENCES league_memberships(id) ON DELETE RESTRICT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      username_snapshot TEXT NOT NULL CHECK(length(trim(username_snapshot)) BETWEEN 1 AND 64),
      eligible_from TEXT NOT NULL CHECK(eligible_from GLOB '????-??-??T??:??:??.???Z' AND julianday(eligible_from) IS NOT NULL),
      eligible_until TEXT CHECK(eligible_until IS NULL OR (eligible_until GLOB '????-??-??T??:??:??.???Z' AND julianday(eligible_until) IS NOT NULL)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
      UNIQUE(season_id,user_id),
      UNIQUE(season_id,membership_id),
      CHECK(eligible_until IS NULL OR eligible_until > eligible_from)
    );
    CREATE INDEX IF NOT EXISTS idx_season_members_user ON season_members(user_id,season_id,id);
    CREATE INDEX IF NOT EXISTS idx_season_members_membership ON season_members(membership_id,season_id,id);
  `);

  if (!columnExists("score_events", "effective_at")) {
    db.exec("ALTER TABLE score_events ADD COLUMN effective_at TEXT");
  }
  const updateEffectiveAt = db.prepare("UPDATE score_events SET effective_at=? WHERE id=?");
  for (const row of db.prepare("SELECT id,created_at FROM score_events WHERE effective_at IS NULL ORDER BY id").all()) {
    let normalized;
    try {
      normalized = normalizeUtcInstant(row.created_at);
    } catch (error) {
      throw new Error(`[reelscore] Migration 9 invalid effective time for score event ${row.id}: ${error.message}`);
    }
    updateEffectiveAt.run(normalized, row.id);
  }
  if (db.prepare("SELECT COUNT(*) count FROM score_events WHERE effective_at IS NULL").get().count !== 0) {
    throw new Error("[reelscore] Migration 9 effective-time backfill incomplete.");
  }
  if (!columnExists("score_events", "projection_source_event_id")) {
    db.exec("ALTER TABLE score_events ADD COLUMN projection_source_event_id INTEGER REFERENCES score_events(id) ON DELETE RESTRICT");
  }
  if (!columnExists("score_events", "season_member_id")) {
    db.exec("ALTER TABLE score_events ADD COLUMN season_member_id INTEGER REFERENCES season_members(id) ON DELETE RESTRICT");
  }

  const orphanSeasons = db.prepare("SELECT COUNT(*) c FROM score_events WHERE season_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seasons WHERE id=score_events.season_id)").get().c;
  if (orphanSeasons !== 0) {
    throw new Error(`[reelscore] Migration 9 refused ${orphanSeasons} orphan non-null season id(s).`);
  }

  const strictCanonicalUtc = (expr) => `(
    typeof(${expr})='text' AND length(${expr})=24 AND
    ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
    CAST(substr(${expr},6,2) AS INTEGER) BETWEEN 1 AND 12 AND
    CAST(substr(${expr},9,2) AS INTEGER) BETWEEN 1 AND CASE CAST(substr(${expr},6,2) AS INTEGER)
      WHEN 2 THEN CASE WHEN (CAST(substr(${expr},1,4) AS INTEGER)%400=0 OR
        (CAST(substr(${expr},1,4) AS INTEGER)%4=0 AND CAST(substr(${expr},1,4) AS INTEGER)%100<>0)) THEN 29 ELSE 28 END
      WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END AND
    CAST(substr(${expr},12,2) AS INTEGER) BETWEEN 0 AND 23 AND
    CAST(substr(${expr},15,2) AS INTEGER) BETWEEN 0 AND 59 AND
    CAST(substr(${expr},18,2) AS INTEGER) BETWEEN 0 AND 59)`;
  const strictLegacyUtc = (expr) => `(
    typeof(${expr})='text' AND length(${expr})=19 AND
    ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND
    CAST(substr(${expr},6,2) AS INTEGER) BETWEEN 1 AND 12 AND
    CAST(substr(${expr},9,2) AS INTEGER) BETWEEN 1 AND CASE CAST(substr(${expr},6,2) AS INTEGER)
      WHEN 2 THEN CASE WHEN (CAST(substr(${expr},1,4) AS INTEGER)%400=0 OR
        (CAST(substr(${expr},1,4) AS INTEGER)%4=0 AND CAST(substr(${expr},1,4) AS INTEGER)%100<>0)) THEN 29 ELSE 28 END
      WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END AND
    CAST(substr(${expr},12,2) AS INTEGER) BETWEEN 0 AND 23 AND
    CAST(substr(${expr},15,2) AS INTEGER) BETWEEN 0 AND 59 AND
    CAST(substr(${expr},18,2) AS INTEGER) BETWEEN 0 AND 59)`;

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_score_events_season_chronology
      ON score_events(season_id,user_id,effective_at,id) WHERE season_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_score_events_original_season_projection
      ON score_events(season_id,projection_source_event_id)
      WHERE projection_source_event_id IS NOT NULL AND reverses_event_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_score_events_projection_source
      ON score_events(projection_source_event_id,season_id,id) WHERE projection_source_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_score_events_season_member
      ON score_events(season_member_id,effective_at,id) WHERE season_member_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_effective_at_validate_insert
    BEFORE INSERT ON score_events
    WHEN NOT (${strictCanonicalUtc("NEW.created_at")} OR ${strictLegacyUtc("NEW.created_at")})
      OR (NEW.effective_at IS NOT NULL AND NOT ${strictCanonicalUtc("NEW.effective_at")})
    BEGIN SELECT RAISE(ABORT,'score event created or effective time invalid'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_effective_at_insert
    AFTER INSERT ON score_events
    WHEN NEW.effective_at IS NULL
    BEGIN UPDATE score_events SET effective_at=strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) WHERE id=NEW.id; END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_effective_at_immutable
    BEFORE UPDATE OF effective_at ON score_events
    WHEN OLD.effective_at IS NOT NULL AND NEW.effective_at IS NOT OLD.effective_at
    BEGIN SELECT RAISE(ABORT,'score event effective time is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_leagues_owner_update
    BEFORE UPDATE OF owner_user_id ON leagues
    WHEN NOT EXISTS (SELECT 1 FROM league_memberships m
      WHERE m.league_id=OLD.id AND m.user_id=NEW.owner_user_id AND m.left_at IS NULL)
    BEGIN SELECT RAISE(ABORT,'league owner membership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_owner_membership_update
    BEFORE UPDATE OF league_id,user_id,left_at ON league_memberships
    WHEN OLD.left_at IS NULL
      AND EXISTS (SELECT 1 FROM leagues l WHERE l.id=OLD.league_id AND l.owner_user_id=OLD.user_id)
      AND (NEW.league_id<>OLD.league_id OR NEW.user_id<>OLD.user_id OR NEW.left_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'league owner membership cannot be closed or moved'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_owner_membership_delete
    BEFORE DELETE ON league_memberships
    WHEN OLD.left_at IS NULL
      AND EXISTS (SELECT 1 FROM leagues l WHERE l.id=OLD.league_id AND l.owner_user_id=OLD.user_id)
    BEGIN SELECT RAISE(ABORT,'league owner membership cannot be deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_membership_identity_immutable
    BEFORE UPDATE OF league_id,user_id,joined_at ON league_memberships
    WHEN NEW.league_id IS NOT OLD.league_id OR NEW.user_id IS NOT OLD.user_id OR NEW.joined_at IS NOT OLD.joined_at
    BEGIN SELECT RAISE(ABORT,'league membership episode identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_membership_close_once
    BEFORE UPDATE OF left_at ON league_memberships
    WHEN OLD.left_at IS NOT NULL OR NEW.left_at IS NULL
    BEGIN SELECT RAISE(ABORT,'league membership episode closure is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_membership_delete
    BEFORE DELETE ON league_memberships
    BEGIN SELECT RAISE(ABORT,'league membership episodes are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_memberships_overlap_insert
    BEFORE INSERT ON league_memberships
    WHEN EXISTS (SELECT 1 FROM league_memberships m WHERE m.league_id=NEW.league_id AND m.user_id=NEW.user_id
      AND NEW.joined_at < COALESCE(m.left_at,'9999-12-31T23:59:59.999Z')
      AND m.joined_at < COALESCE(NEW.left_at,'9999-12-31T23:59:59.999Z'))
    BEGIN SELECT RAISE(ABORT,'league membership tenure overlap'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_memberships_overlap_update
    BEFORE UPDATE OF league_id,user_id,joined_at,left_at ON league_memberships
    WHEN EXISTS (SELECT 1 FROM league_memberships m WHERE m.id<>OLD.id AND m.league_id=NEW.league_id AND m.user_id=NEW.user_id
      AND NEW.joined_at < COALESCE(m.left_at,'9999-12-31T23:59:59.999Z')
      AND m.joined_at < COALESCE(NEW.left_at,'9999-12-31T23:59:59.999Z'))
    BEGIN SELECT RAISE(ABORT,'league membership tenure overlap'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_membership_cutoff_update
    BEFORE UPDATE OF league_id,user_id,left_at ON league_memberships
    WHEN EXISTS (SELECT 1 FROM season_members sm JOIN seasons s ON s.id=sm.season_id
      WHERE sm.membership_id=OLD.id AND (NEW.league_id<>s.league_id OR NEW.user_id<>sm.user_id
        OR (NEW.left_at IS NOT NULL AND NEW.left_at<s.ends_at AND (sm.eligible_until IS NULL OR sm.eligible_until>NEW.left_at))))
    BEGIN SELECT RAISE(ABORT,'season participant cutoff mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invites_creator_insert
    BEFORE INSERT ON league_invites
    WHEN NOT EXISTS (SELECT 1 FROM leagues l WHERE l.id=NEW.league_id
      AND (l.owner_user_id=NEW.created_by_user_id OR EXISTS (SELECT 1 FROM league_memberships m
        WHERE m.league_id=l.id AND m.user_id=NEW.created_by_user_id AND m.left_at IS NULL AND m.role='admin')))
    BEGIN SELECT RAISE(ABORT,'league invite creator ownership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invites_creator_update
    BEFORE UPDATE OF league_id,created_by_user_id ON league_invites
    WHEN NOT EXISTS (SELECT 1 FROM leagues l WHERE l.id=NEW.league_id
      AND (l.owner_user_id=NEW.created_by_user_id OR EXISTS (SELECT 1 FROM league_memberships m
        WHERE m.league_id=l.id AND m.user_id=NEW.created_by_user_id AND m.left_at IS NULL AND m.role='admin')))
    BEGIN SELECT RAISE(ABORT,'league invite creator ownership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_leagues_delete
    BEFORE DELETE ON leagues
    BEGIN SELECT RAISE(ABORT,'leagues are archived, not deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invites_delete
    BEFORE DELETE ON league_invites
    BEGIN SELECT RAISE(ABORT,'league invites are revoked, not deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invite_uses_insert
    BEFORE INSERT ON league_invite_uses
    WHEN NOT EXISTS (SELECT 1 FROM league_invites i JOIN league_memberships m ON m.id=NEW.membership_id
      WHERE i.id=NEW.invite_id AND m.league_id=i.league_id AND m.user_id=NEW.user_id
        AND i.revoked_at IS NULL AND NEW.used_at<i.expires_at
        AND m.joined_at<=NEW.used_at AND (m.left_at IS NULL OR NEW.used_at<=m.left_at))
      OR (SELECT COUNT(*) FROM league_invite_uses u WHERE u.invite_id=NEW.invite_id) >=
         (SELECT max_uses FROM league_invites WHERE id=NEW.invite_id)
    BEGIN SELECT RAISE(ABORT,'league invite use capacity or ownership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invite_uses_immutable
    BEFORE UPDATE ON league_invite_uses
    BEGIN SELECT RAISE(ABORT,'league invite uses are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invite_uses_delete
    BEFORE DELETE ON league_invite_uses
    BEGIN SELECT RAISE(ABORT,'league invite use audit is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invites_identity_immutable
    BEFORE UPDATE OF league_id,created_by_user_id,token_hash,max_uses,expires_at ON league_invites
    WHEN NEW.league_id IS NOT OLD.league_id OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
      OR NEW.token_hash IS NOT OLD.token_hash OR NEW.max_uses IS NOT OLD.max_uses
      OR NEW.expires_at IS NOT OLD.expires_at
    BEGIN SELECT RAISE(ABORT,'league invite identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_league_invites_revoke_once
    BEFORE UPDATE OF revoked_at ON league_invites
    WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    BEGIN SELECT RAISE(ABORT,'league invite revocation is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_lifecycle_insert
    BEFORE INSERT ON seasons
    WHEN NEW.finalized_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'season lifecycle transitions cannot be pre-applied'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_creator_insert
    BEFORE INSERT ON seasons
    WHEN NOT EXISTS (SELECT 1 FROM leagues l WHERE l.id=NEW.league_id
      AND (l.owner_user_id=NEW.created_by_user_id OR EXISTS (SELECT 1 FROM league_memberships m
        WHERE m.league_id=l.id AND m.user_id=NEW.created_by_user_id AND m.left_at IS NULL AND m.role='admin')))
    BEGIN SELECT RAISE(ABORT,'season creator ownership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_creator_update
    BEFORE UPDATE OF league_id,created_by_user_id ON seasons
    WHEN NOT EXISTS (SELECT 1 FROM leagues l WHERE l.id=NEW.league_id
      AND (l.owner_user_id=NEW.created_by_user_id OR EXISTS (SELECT 1 FROM league_memberships m
        WHERE m.league_id=l.id AND m.user_id=NEW.created_by_user_id AND m.left_at IS NULL AND m.role='admin')))
    BEGIN SELECT RAISE(ABORT,'season creator ownership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_overlap_insert
    BEFORE INSERT ON seasons
    WHEN NEW.cancelled_at IS NULL AND EXISTS (SELECT 1 FROM seasons s WHERE s.league_id=NEW.league_id
      AND s.cancelled_at IS NULL AND NEW.starts_at<s.ends_at AND s.starts_at<NEW.ends_at)
    BEGIN SELECT RAISE(ABORT,'noncancelled season overlap'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_overlap_update
    BEFORE UPDATE OF league_id,starts_at,ends_at,cancelled_at ON seasons
    WHEN NEW.cancelled_at IS NULL AND EXISTS (SELECT 1 FROM seasons s WHERE s.id<>OLD.id AND s.league_id=NEW.league_id
      AND s.cancelled_at IS NULL AND NEW.starts_at<s.ends_at AND s.starts_at<NEW.ends_at)
    BEGIN SELECT RAISE(ABORT,'noncancelled season overlap'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_participant_lock_update
    BEFORE UPDATE OF participants_locked_at ON seasons
    WHEN (OLD.participants_locked_at IS NOT NULL AND NEW.participants_locked_at IS NOT OLD.participants_locked_at)
      OR (NEW.participants_locked_at IS NOT NULL AND NEW.participants_locked_at<NEW.starts_at)
    BEGIN SELECT RAISE(ABORT,'season participant lock is immutable or before season start'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_finalize_requires_snapshot
    BEFORE UPDATE OF finalized_at ON seasons
    WHEN NEW.finalized_at IS NOT NULL AND NEW.participants_locked_at IS NULL
    BEGIN SELECT RAISE(ABORT,'season participant snapshot must be locked before finalization'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_finalize_once
    BEFORE UPDATE OF finalized_at ON seasons
    WHEN OLD.finalized_at IS NOT NULL OR NEW.finalized_at IS NULL
    BEGIN SELECT RAISE(ABORT,'season finalization is irreversible'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_cancel_once
    BEFORE UPDATE OF cancelled_at ON seasons
    WHEN OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL
    BEGIN SELECT RAISE(ABORT,'season cancellation is irreversible'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_finalized_immutable
    BEFORE UPDATE ON seasons
    WHEN OLD.finalized_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'finalized season is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_cancelled_immutable
    BEFORE UPDATE ON seasons
    WHEN OLD.cancelled_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'cancelled season is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_delete
    BEFORE DELETE ON seasons
    BEGIN SELECT RAISE(ABORT,'season records are immutable; cancel scheduled seasons'); END;

    CREATE TRIGGER IF NOT EXISTS trg_seasons_started_settings_update
    BEFORE UPDATE OF league_id,mode,timezone,rule_version,starts_at,ends_at ON seasons
    WHEN (OLD.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR EXISTS (SELECT 1 FROM season_members WHERE season_id=OLD.id))
      AND (NEW.league_id<>OLD.league_id OR NEW.mode<>OLD.mode OR NEW.timezone<>OLD.timezone
        OR NEW.rule_version<>OLD.rule_version OR NEW.starts_at<>OLD.starts_at OR NEW.ends_at<>OLD.ends_at)
    BEGIN SELECT RAISE(ABORT,'started season settings are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_set_insert
    BEFORE INSERT ON season_members
    WHEN EXISTS (SELECT 1 FROM seasons s WHERE s.id=NEW.season_id
      AND (s.participants_locked_at IS NOT NULL OR s.finalized_at IS NOT NULL OR s.cancelled_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'season participant set is locked or frozen'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_owner_insert
    BEFORE INSERT ON season_members
    WHEN NOT EXISTS (SELECT 1 FROM seasons s JOIN league_memberships m ON m.id=NEW.membership_id
      WHERE s.id=NEW.season_id AND m.league_id=s.league_id AND m.user_id=NEW.user_id
        AND m.joined_at<s.starts_at AND (m.left_at IS NULL OR m.left_at>s.starts_at)
        AND NEW.eligible_from=s.starts_at AND (NEW.eligible_until IS NULL OR NEW.eligible_until<=s.ends_at)
        AND (m.left_at IS NULL OR m.left_at>=s.ends_at OR NEW.eligible_until IS NOT NULL AND NEW.eligible_until<=m.left_at))
    BEGIN SELECT RAISE(ABORT,'season participant ownership or cutoff mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_snapshot_immutable
    BEFORE UPDATE OF season_id,membership_id,user_id,username_snapshot,eligible_from ON season_members
    WHEN NEW.season_id IS NOT OLD.season_id OR NEW.membership_id IS NOT OLD.membership_id
      OR NEW.user_id IS NOT OLD.user_id OR NEW.username_snapshot IS NOT OLD.username_snapshot
      OR NEW.eligible_from IS NOT OLD.eligible_from
    BEGIN SELECT RAISE(ABORT,'season participant snapshot is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_cutoff_once
    BEFORE UPDATE OF eligible_until ON season_members
    WHEN OLD.eligible_until IS NOT NULL OR NEW.eligible_until IS NULL
    BEGIN SELECT RAISE(ABORT,'season participant cutoff is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_delete
    BEFORE DELETE ON season_members
    WHEN EXISTS (SELECT 1 FROM seasons s WHERE s.id=OLD.season_id
      AND (s.participants_locked_at IS NOT NULL OR s.finalized_at IS NOT NULL OR s.cancelled_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'season participant set is locked or frozen'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_owner_update
    BEFORE UPDATE OF season_id,membership_id,user_id,eligible_from,eligible_until ON season_members
    WHEN NOT EXISTS (SELECT 1 FROM seasons s JOIN league_memberships m ON m.id=NEW.membership_id
      WHERE s.id=NEW.season_id AND m.league_id=s.league_id AND m.user_id=NEW.user_id
        AND m.joined_at<s.starts_at AND (m.left_at IS NULL OR m.left_at>s.starts_at)
        AND NEW.eligible_from=s.starts_at AND (NEW.eligible_until IS NULL OR NEW.eligible_until<=s.ends_at)
        AND (m.left_at IS NULL OR m.left_at>=s.ends_at OR NEW.eligible_until IS NOT NULL AND NEW.eligible_until<=m.left_at))
    BEGIN SELECT RAISE(ABORT,'season participant ownership or cutoff mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_watches_provider_tuple_insert
    BEFORE INSERT ON watches
    WHEN (NEW.provider_service IS NOT NULL OR NEW.provider_connection_id IS NOT NULL OR NEW.provider_event_id IS NOT NULL)
      AND (NEW.provider_service IS NULL OR trim(NEW.provider_service)=''
        OR NEW.provider_connection_id IS NULL OR trim(NEW.provider_connection_id)=''
        OR NEW.provider_event_id IS NULL OR trim(NEW.provider_event_id)=''
        OR NEW.source='manual' OR NEW.source<>NEW.provider_service)
    BEGIN SELECT RAISE(ABORT,'provider watch identity is incomplete or inconsistent'); END;

    CREATE TRIGGER IF NOT EXISTS trg_watches_provider_tuple_update
    BEFORE UPDATE OF source,provider_service,provider_connection_id,provider_event_id ON watches
    WHEN (NEW.provider_service IS NOT NULL OR NEW.provider_connection_id IS NOT NULL OR NEW.provider_event_id IS NOT NULL)
      AND (NEW.provider_service IS NULL OR trim(NEW.provider_service)=''
        OR NEW.provider_connection_id IS NULL OR trim(NEW.provider_connection_id)=''
        OR NEW.provider_event_id IS NULL OR trim(NEW.provider_event_id)=''
        OR NEW.source='manual' OR NEW.source<>NEW.provider_service)
    BEGIN SELECT RAISE(ABORT,'provider watch identity is incomplete or inconsistent'); END;

    CREATE TRIGGER IF NOT EXISTS trg_watches_provider_tuple_immutable
    BEFORE UPDATE OF source,provider_service,provider_connection_id,provider_event_id ON watches
    WHEN OLD.provider_event_id IS NOT NULL AND
      (NEW.source IS NOT OLD.source OR NEW.provider_service IS NOT OLD.provider_service
        OR NEW.provider_connection_id IS NOT OLD.provider_connection_id OR NEW.provider_event_id IS NOT OLD.provider_event_id)
    BEGIN SELECT RAISE(ABORT,'provider watch identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_ledger_identity_immutable
    BEFORE UPDATE OF event_key,user_id,watch_id,achievement_id,season_id,category,points,rule_version,metadata_json,created_at,reverses_event_id,projection_source_event_id,season_member_id ON score_events
    WHEN NEW.event_key IS NOT OLD.event_key OR NEW.user_id IS NOT OLD.user_id OR NEW.watch_id IS NOT OLD.watch_id
      OR NEW.achievement_id IS NOT OLD.achievement_id OR NEW.season_id IS NOT OLD.season_id
      OR NEW.category IS NOT OLD.category OR NEW.points IS NOT OLD.points OR NEW.rule_version IS NOT OLD.rule_version
      OR NEW.metadata_json IS NOT OLD.metadata_json OR NEW.created_at IS NOT OLD.created_at
      OR NEW.reverses_event_id IS NOT OLD.reverses_event_id
      OR NEW.projection_source_event_id IS NOT OLD.projection_source_event_id
      OR NEW.season_member_id IS NOT OLD.season_member_id
    BEGIN SELECT RAISE(ABORT,'score event source/owner mismatch; ledger identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_reversal_shape_insert
    BEFORE INSERT ON score_events
    WHEN NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM score_events parent WHERE parent.id=NEW.reverses_event_id
        AND NEW.user_id=parent.user_id AND NEW.watch_id IS parent.watch_id
        AND NEW.achievement_id IS parent.achievement_id AND NEW.season_id IS parent.season_id
        AND NEW.projection_source_event_id IS parent.projection_source_event_id
        AND NEW.season_member_id IS parent.season_member_id AND NEW.category=parent.category
        AND NEW.points=-parent.points AND NEW.rule_version=parent.rule_version
        AND NEW.effective_at=parent.effective_at
        AND (parent.reverses_event_id IS NULL OR
          (parent.season_id IS NOT NULL AND parent.projection_source_event_id IS NOT NULL)))
    BEGIN SELECT RAISE(ABORT,'score reversal does not exactly compensate its parent'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_reversal_marks_parent
    AFTER INSERT ON score_events
    WHEN NEW.reverses_event_id IS NOT NULL
    BEGIN UPDATE score_events SET reversed_at=NEW.created_at WHERE id=NEW.reverses_event_id AND reversed_at IS NULL; END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_reversed_at_once
    BEFORE UPDATE OF reversed_at ON score_events
    WHEN OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL
      OR NOT EXISTS (SELECT 1 FROM score_events child
        WHERE child.reverses_event_id=OLD.id AND child.created_at=NEW.reversed_at)
    BEGIN SELECT RAISE(ABORT,'score reversal marker is derived and immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_projection_copy_insert
    BEFORE INSERT ON score_events
    WHEN NEW.season_id IS NOT NULL AND NEW.reverses_event_id IS NULL
      AND NEW.projection_source_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM score_events src
        JOIN watches w ON w.id=src.watch_id AND w.user_id=src.user_id
        JOIN seasons season ON season.id=NEW.season_id
        JOIN leagues league ON league.id=season.league_id
        JOIN season_members member ON member.id=NEW.season_member_id
          AND member.season_id=season.id AND member.user_id=src.user_id
        WHERE src.id=NEW.projection_source_event_id AND src.season_id IS NULL
          AND src.reverses_event_id IS NULL AND src.reversed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM score_events child WHERE child.reverses_event_id=src.id)
          AND NEW.user_id=src.user_id AND NEW.watch_id=src.watch_id
          AND NEW.category=src.category AND NEW.points=src.points
          AND NEW.rule_version=src.rule_version AND NEW.effective_at=src.effective_at
          AND src.category IN ('watch_first','watch_rewatch','watch_cooldown')
          AND NEW.event_key='season/'||season.id||'/watch-event/'||src.id
          AND w.deleted_at IS NULL AND w.qualifies_for_season=1
          AND season.participants_locked_at IS NOT NULL
          AND season.cancelled_at IS NULL AND season.finalized_at IS NULL AND league.archived_at IS NULL
          AND src.effective_at>=season.starts_at AND src.effective_at<season.ends_at
          AND src.effective_at>=member.eligible_from
          AND src.effective_at<COALESCE(member.eligible_until,season.ends_at)
          AND (season.mode<>'verified' OR
            (w.source<>'manual' AND w.source=w.provider_service
              AND w.provider_connection_id IS NOT NULL AND w.provider_event_id IS NOT NULL)
            OR (w.source='manual' AND EXISTS (
              SELECT 1 FROM duplicate_cases duplicate_case
              JOIN watches provider_watch ON provider_watch.id=duplicate_case.candidate_watch_id
              WHERE duplicate_case.user_id=w.user_id AND duplicate_case.canonical_watch_id=w.id
                AND duplicate_case.status='resolved' AND duplicate_case.resolution='merge'
                AND duplicate_case.cancelled_at IS NULL
                AND provider_watch.user_id=w.user_id AND provider_watch.deleted_at IS NOT NULL
                AND provider_watch.deleted_reason='duplicate_merged'
                AND provider_watch.logical_canonical_watch_id=w.id
                AND provider_watch.source<>'manual' AND provider_watch.source=provider_watch.provider_service
                AND provider_watch.provider_connection_id IS NOT NULL AND provider_watch.provider_event_id IS NOT NULL))))
    BEGIN SELECT RAISE(ABORT,'season projection does not exactly copy its lifetime source'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_season_frozen_insert
    BEFORE INSERT ON score_events
    WHEN NEW.season_id IS NOT NULL AND EXISTS (SELECT 1 FROM seasons s
      WHERE s.id=NEW.season_id AND (s.finalized_at IS NOT NULL OR s.cancelled_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM leagues l WHERE l.id=s.league_id AND l.archived_at IS NOT NULL)))
    BEGIN SELECT RAISE(ABORT,'finalized or cancelled season standings are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_season_frozen_update
    BEFORE UPDATE ON score_events
    WHEN OLD.season_id IS NOT NULL AND EXISTS (SELECT 1 FROM seasons s
      WHERE s.id=OLD.season_id AND (s.finalized_at IS NOT NULL OR s.cancelled_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM leagues l WHERE l.id=s.league_id AND l.archived_at IS NOT NULL)))
    BEGIN SELECT RAISE(ABORT,'finalized or cancelled season standings are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_delete
    BEFORE DELETE ON score_events
    BEGIN SELECT RAISE(ABORT,'score ledger rows are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_frozen_update
    BEFORE UPDATE ON season_members
    WHEN EXISTS (SELECT 1 FROM seasons s WHERE s.id=OLD.season_id
      AND (s.finalized_at IS NOT NULL OR s.cancelled_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'finalized or cancelled season participants are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_season_integrity_insert
    BEFORE INSERT ON score_events
    WHEN (NEW.season_id IS NULL AND (NEW.projection_source_event_id IS NOT NULL OR NEW.season_member_id IS NOT NULL))
      OR (NEW.season_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.id=NEW.season_id))
      OR (NEW.season_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM season_members sm
            WHERE sm.id=NEW.season_member_id AND sm.season_id=NEW.season_id AND sm.user_id=NEW.user_id))
      OR (NEW.season_id IS NOT NULL AND NEW.reverses_event_id IS NULL
            AND NEW.category IN ('watch_first','watch_rewatch','watch_cooldown') AND NEW.projection_source_event_id IS NULL)
      OR (NEW.projection_source_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM score_events src
            WHERE src.id=NEW.projection_source_event_id AND src.season_id IS NULL AND src.user_id=NEW.user_id
              AND src.watch_id IS NOT NULL AND src.watch_id=NEW.watch_id))
    BEGIN SELECT RAISE(ABORT,'score event season projection source or participant mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_season_integrity_update
    BEFORE UPDATE OF user_id,watch_id,season_id,projection_source_event_id,season_member_id ON score_events
    WHEN (NEW.season_id IS NULL AND (NEW.projection_source_event_id IS NOT NULL OR NEW.season_member_id IS NOT NULL))
      OR (NEW.season_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.id=NEW.season_id))
      OR (NEW.season_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM season_members sm
            WHERE sm.id=NEW.season_member_id AND sm.season_id=NEW.season_id AND sm.user_id=NEW.user_id))
      OR (NEW.season_id IS NOT NULL AND NEW.reverses_event_id IS NULL
            AND NEW.category IN ('watch_first','watch_rewatch','watch_cooldown') AND NEW.projection_source_event_id IS NULL)
      OR (NEW.projection_source_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM score_events src
            WHERE src.id=NEW.projection_source_event_id AND src.season_id IS NULL AND src.user_id=NEW.user_id
              AND src.watch_id IS NOT NULL AND src.watch_id=NEW.watch_id))
      OR EXISTS (SELECT 1 FROM score_events child WHERE child.projection_source_event_id=OLD.id
            AND (NEW.season_id IS NOT NULL OR child.user_id IS NOT NEW.user_id OR child.watch_id IS NOT NEW.watch_id))
    BEGIN SELECT RAISE(ABORT,'score event season projection source or participant mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_season_members_score_owner_update
    BEFORE UPDATE OF season_id,user_id ON season_members
    WHEN EXISTS (SELECT 1 FROM score_events e WHERE e.season_member_id=OLD.id
      AND (e.season_id<>NEW.season_id OR e.user_id<>NEW.user_id))
    BEGIN SELECT RAISE(ABORT,'season participant has mismatched score rows'); END;
  `);

  const strictTimestampColumns = {
    leagues: { required: ["created_at","updated_at"], nullable: ["archived_at"] },
    league_memberships: { required: ["joined_at","created_at"], nullable: ["left_at"] },
    league_invites: { required: ["expires_at","created_at"], nullable: ["revoked_at"] },
    league_invite_uses: { required: ["used_at"], nullable: [] },
    seasons: { required: ["starts_at","ends_at","created_at","updated_at"], nullable: ["cancelled_at","finalized_at","participants_locked_at"] },
    season_members: { required: ["eligible_from","created_at"], nullable: ["eligible_until"] },
  };
  for (const [table, columns] of Object.entries(strictTimestampColumns)) {
    const invalid = [
      ...columns.required.map((column) => `NOT ${strictCanonicalUtc(`NEW.${column}`)}`),
      ...columns.nullable.map((column) => `(NEW.${column} IS NOT NULL AND NOT ${strictCanonicalUtc(`NEW.${column}`)})`),
    ].join(" OR ");
    const watched = [...columns.required, ...columns.nullable].join(",");
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_strict_time_insert BEFORE INSERT ON ${table}
      WHEN ${invalid} BEGIN SELECT RAISE(ABORT,'${table} timestamp invalid'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_strict_time_update BEFORE UPDATE OF ${watched} ON ${table}
      WHEN ${invalid} BEGIN SELECT RAISE(ABORT,'${table} timestamp invalid'); END;`);
  }

  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (9)").run();
}

function migration10() {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_watches_provider_tuple_insert;
    DROP TRIGGER IF EXISTS trg_watches_provider_tuple_update;
    DROP TRIGGER IF EXISTS trg_watches_provider_tuple_immutable;
    DROP TRIGGER IF EXISTS trg_score_events_reversal_shape_insert;
    DROP TRIGGER IF EXISTS trg_score_events_reversal_marks_parent;
    DROP TRIGGER IF EXISTS trg_score_events_reversed_at_once;
    DROP TRIGGER IF EXISTS trg_score_events_projection_copy_insert;
    DROP TRIGGER IF EXISTS trg_score_events_season_frozen_insert;
    DROP TRIGGER IF EXISTS trg_score_events_season_frozen_update;

    CREATE TRIGGER trg_watches_provider_tuple_insert BEFORE INSERT ON watches
    WHEN (NEW.provider_service IS NOT NULL OR NEW.provider_connection_id IS NOT NULL OR NEW.provider_event_id IS NOT NULL)
      AND (NEW.provider_service IS NULL OR trim(NEW.provider_service)='' OR NEW.provider_connection_id IS NULL
        OR trim(NEW.provider_connection_id)='' OR NEW.provider_event_id IS NULL OR trim(NEW.provider_event_id)=''
        OR NEW.source='manual' OR NEW.source<>NEW.provider_service)
    BEGIN SELECT RAISE(ABORT,'provider watch identity is incomplete or inconsistent'); END;
    CREATE TRIGGER trg_watches_provider_tuple_update BEFORE UPDATE OF source,provider_service,provider_connection_id,provider_event_id ON watches
    WHEN (NEW.provider_service IS NOT NULL OR NEW.provider_connection_id IS NOT NULL OR NEW.provider_event_id IS NOT NULL)
      AND (NEW.provider_service IS NULL OR trim(NEW.provider_service)='' OR NEW.provider_connection_id IS NULL
        OR trim(NEW.provider_connection_id)='' OR NEW.provider_event_id IS NULL OR trim(NEW.provider_event_id)=''
        OR NEW.source='manual' OR NEW.source<>NEW.provider_service)
    BEGIN SELECT RAISE(ABORT,'provider watch identity is incomplete or inconsistent'); END;
    CREATE TRIGGER trg_watches_provider_tuple_immutable BEFORE UPDATE OF source,provider_service,provider_connection_id,provider_event_id ON watches
    WHEN OLD.provider_event_id IS NOT NULL AND (NEW.source IS NOT OLD.source OR NEW.provider_service IS NOT OLD.provider_service
      OR NEW.provider_connection_id IS NOT OLD.provider_connection_id OR NEW.provider_event_id IS NOT OLD.provider_event_id)
    BEGIN SELECT RAISE(ABORT,'provider watch identity is immutable'); END;

    CREATE TRIGGER trg_score_events_reversal_shape_insert BEFORE INSERT ON score_events
    WHEN NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM score_events parent WHERE parent.id=NEW.reverses_event_id
        AND NEW.user_id=parent.user_id AND NEW.watch_id IS parent.watch_id AND NEW.achievement_id IS parent.achievement_id
        AND NEW.season_id IS parent.season_id AND NEW.projection_source_event_id IS parent.projection_source_event_id
        AND NEW.season_member_id IS parent.season_member_id AND NEW.category=parent.category
        AND NEW.points=-parent.points AND NEW.rule_version=parent.rule_version AND NEW.effective_at=parent.effective_at
        AND (parent.reverses_event_id IS NULL OR (parent.season_id IS NOT NULL AND parent.projection_source_event_id IS NOT NULL)))
    BEGIN SELECT RAISE(ABORT,'score reversal does not exactly compensate its parent'); END;
    CREATE TRIGGER trg_score_events_reversal_marks_parent AFTER INSERT ON score_events WHEN NEW.reverses_event_id IS NOT NULL
    BEGIN UPDATE score_events SET reversed_at=NEW.created_at WHERE id=NEW.reverses_event_id AND reversed_at IS NULL; END;
    CREATE TRIGGER trg_score_events_reversed_at_once BEFORE UPDATE OF reversed_at ON score_events
    WHEN OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM score_events child WHERE child.reverses_event_id=OLD.id AND child.created_at=NEW.reversed_at)
    BEGIN SELECT RAISE(ABORT,'score reversal marker is derived and immutable'); END;

    CREATE TRIGGER trg_score_events_projection_copy_insert BEFORE INSERT ON score_events
    WHEN NEW.season_id IS NOT NULL AND NEW.reverses_event_id IS NULL AND NEW.projection_source_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM score_events src JOIN watches w ON w.id=src.watch_id AND w.user_id=src.user_id
        JOIN seasons season ON season.id=NEW.season_id JOIN leagues league ON league.id=season.league_id
        JOIN season_members member ON member.id=NEW.season_member_id AND member.season_id=season.id AND member.user_id=src.user_id
        WHERE src.id=NEW.projection_source_event_id AND src.season_id IS NULL AND src.reverses_event_id IS NULL
          AND src.reversed_at IS NULL AND NOT EXISTS (SELECT 1 FROM score_events child WHERE child.reverses_event_id=src.id)
          AND NEW.user_id=src.user_id AND NEW.watch_id=src.watch_id AND NEW.category=src.category AND NEW.points=src.points
          AND NEW.rule_version=src.rule_version AND NEW.effective_at=src.effective_at
          AND src.category IN ('watch_first','watch_rewatch','watch_cooldown')
          AND NEW.event_key='season/'||season.id||'/watch-event/'||src.id
          AND w.deleted_at IS NULL AND w.qualifies_for_season=1 AND season.participants_locked_at IS NOT NULL
          AND season.cancelled_at IS NULL AND season.finalized_at IS NULL AND league.archived_at IS NULL
          AND src.effective_at>=season.starts_at AND src.effective_at<season.ends_at
          AND src.effective_at>=member.eligible_from AND src.effective_at<COALESCE(member.eligible_until,season.ends_at)
          AND (season.mode<>'verified' OR
            (w.source<>'manual' AND w.source=w.provider_service AND w.provider_connection_id IS NOT NULL AND w.provider_event_id IS NOT NULL)
            OR (w.source='manual' AND EXISTS (
              SELECT 1 FROM duplicate_cases duplicate_case JOIN watches provider_watch ON provider_watch.id=duplicate_case.candidate_watch_id
              WHERE duplicate_case.user_id=w.user_id AND duplicate_case.canonical_watch_id=w.id
                AND duplicate_case.status='resolved' AND duplicate_case.resolution='merge' AND duplicate_case.cancelled_at IS NULL
                AND provider_watch.user_id=w.user_id AND provider_watch.deleted_at IS NOT NULL
                AND provider_watch.deleted_reason='duplicate_merged' AND provider_watch.logical_canonical_watch_id=w.id
                AND provider_watch.source<>'manual' AND provider_watch.source=provider_watch.provider_service
                AND provider_watch.provider_connection_id IS NOT NULL AND provider_watch.provider_event_id IS NOT NULL))))
    BEGIN SELECT RAISE(ABORT,'season projection does not exactly copy an eligible lifetime source'); END;

    CREATE TRIGGER trg_score_events_season_frozen_insert BEFORE INSERT ON score_events
    WHEN NEW.season_id IS NOT NULL AND EXISTS (SELECT 1 FROM seasons season JOIN leagues league ON league.id=season.league_id
      WHERE season.id=NEW.season_id AND (season.finalized_at IS NOT NULL OR season.cancelled_at IS NOT NULL OR league.archived_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'finalized, cancelled, or archived season standings are immutable'); END;
    CREATE TRIGGER trg_score_events_season_frozen_update BEFORE UPDATE ON score_events
    WHEN OLD.season_id IS NOT NULL AND EXISTS (SELECT 1 FROM seasons season JOIN leagues league ON league.id=season.league_id
      WHERE season.id=OLD.season_id AND (season.finalized_at IS NOT NULL OR season.cancelled_at IS NOT NULL OR league.archived_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'finalized, cancelled, or archived season standings are immutable'); END;
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (10)").run();
}

// Audit records are immutable after insertion so security history cannot be rewritten.
function migration11() {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_audit_log_append_only_insert
    BEFORE INSERT ON audit_log
    WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_append_only_update
    BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_append_only_delete
    BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (11)").run();
}

// Placeholder reconciliation keeps provider proof on the deleted provider watch.
function migration12() {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_score_events_projection_copy_insert;
    CREATE TRIGGER trg_score_events_projection_copy_insert BEFORE INSERT ON score_events
    WHEN NEW.season_id IS NOT NULL AND NEW.reverses_event_id IS NULL AND NEW.projection_source_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM score_events src JOIN watches w ON w.id=src.watch_id AND w.user_id=src.user_id
        JOIN seasons season ON season.id=NEW.season_id JOIN leagues league ON league.id=season.league_id
        JOIN season_members member ON member.id=NEW.season_member_id AND member.season_id=season.id AND member.user_id=src.user_id
        WHERE src.id=NEW.projection_source_event_id AND src.season_id IS NULL AND src.reverses_event_id IS NULL
          AND src.reversed_at IS NULL AND NOT EXISTS (SELECT 1 FROM score_events child WHERE child.reverses_event_id=src.id)
          AND NEW.user_id=src.user_id AND NEW.watch_id=src.watch_id AND NEW.category=src.category AND NEW.points=src.points
          AND NEW.rule_version=src.rule_version AND NEW.effective_at=src.effective_at
          AND src.category IN ('watch_first','watch_rewatch','watch_cooldown')
          AND NEW.event_key='season/'||season.id||'/watch-event/'||src.id
          AND w.deleted_at IS NULL AND w.qualifies_for_season=1 AND season.participants_locked_at IS NOT NULL
          AND season.cancelled_at IS NULL AND season.finalized_at IS NULL AND league.archived_at IS NULL
          AND src.effective_at>=season.starts_at AND src.effective_at<season.ends_at
          AND src.effective_at>=member.eligible_from AND src.effective_at<COALESCE(member.eligible_until,season.ends_at)
          AND (season.mode<>'verified' OR
            (w.source<>'manual' AND w.source=w.provider_service AND w.provider_connection_id IS NOT NULL AND w.provider_event_id IS NOT NULL)
            OR EXISTS (
              SELECT 1 FROM watches placeholder_provider
              WHERE placeholder_provider.user_id=w.user_id AND placeholder_provider.logical_canonical_watch_id=w.id
                AND placeholder_provider.deleted_at IS NOT NULL AND placeholder_provider.deleted_reason='placeholder_reconciled'
                AND placeholder_provider.source<>'manual' AND placeholder_provider.source=placeholder_provider.provider_service
                AND placeholder_provider.provider_connection_id IS NOT NULL AND placeholder_provider.provider_event_id IS NOT NULL)
            OR (w.source='manual' AND EXISTS (
              SELECT 1 FROM duplicate_cases duplicate_case JOIN watches provider_watch ON provider_watch.id=duplicate_case.candidate_watch_id
              WHERE duplicate_case.user_id=w.user_id AND duplicate_case.canonical_watch_id=w.id
                AND duplicate_case.status='resolved' AND duplicate_case.resolution='merge' AND duplicate_case.cancelled_at IS NULL
                AND provider_watch.user_id=w.user_id AND provider_watch.deleted_at IS NOT NULL
                AND provider_watch.deleted_reason='duplicate_merged' AND provider_watch.logical_canonical_watch_id=w.id
                AND provider_watch.source<>'manual' AND provider_watch.source=provider_watch.provider_service
                AND provider_watch.provider_connection_id IS NOT NULL AND provider_watch.provider_event_id IS NOT NULL))))
    BEGIN SELECT RAISE(ABORT,'season projection does not exactly copy an eligible lifetime source'); END;
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (12)").run();
}


// Challenge definitions and immutable season assignment/completion records.
function migration13() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS challenge_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      slug TEXT NOT NULL CHECK(length(slug) BETWEEN 1 AND 64 AND substr(slug,1,1) GLOB '[a-z0-9]' AND slug NOT GLOB '*[^a-z0-9_-]*'),
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 100),
      description TEXT CHECK(description IS NULL OR length(description) <= 1000),
      points INTEGER NOT NULL CHECK(points BETWEEN 1 AND 10000),
      rule_version TEXT NOT NULL CHECK(length(trim(rule_version)) BETWEEN 1 AND 64),
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      archived_at TEXT CHECK(archived_at IS NULL OR (archived_at GLOB '????-??-??T??:??:??.???Z' AND julianday(archived_at) IS NOT NULL)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(updated_at GLOB '????-??-??T??:??:??.???Z' AND julianday(updated_at) IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_definitions_league_slug_active
      ON challenge_definitions(league_id,slug) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_challenge_definitions_league ON challenge_definitions(league_id,archived_at,id);

    CREATE TABLE IF NOT EXISTS challenge_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      challenge_definition_id INTEGER NOT NULL REFERENCES challenge_definitions(id) ON DELETE RESTRICT,
      season_member_id INTEGER NOT NULL REFERENCES season_members(id) ON DELETE RESTRICT,
      assigned_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      challenge_slug_snapshot TEXT NOT NULL CHECK(length(challenge_slug_snapshot) BETWEEN 1 AND 64 AND substr(challenge_slug_snapshot,1,1) GLOB '[a-z0-9]' AND challenge_slug_snapshot NOT GLOB '*[^a-z0-9_-]*'),
      challenge_title_snapshot TEXT NOT NULL CHECK(length(trim(challenge_title_snapshot)) BETWEEN 1 AND 100),
      challenge_description_snapshot TEXT CHECK(challenge_description_snapshot IS NULL OR length(challenge_description_snapshot) <= 1000),
      challenge_points_snapshot INTEGER NOT NULL CHECK(challenge_points_snapshot BETWEEN 1 AND 10000),
      challenge_rule_version_snapshot TEXT NOT NULL CHECK(length(trim(challenge_rule_version_snapshot)) BETWEEN 1 AND 64),
      status TEXT NOT NULL CHECK(status IN ('pending','completed','cancelled')),
      assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(assigned_at GLOB '????-??-??T??:??:??.???Z' AND julianday(assigned_at) IS NOT NULL),
      completed_at TEXT CHECK(completed_at IS NULL OR (completed_at GLOB '????-??-??T??:??:??.???Z' AND julianday(completed_at) IS NOT NULL)),
      cancelled_at TEXT CHECK(cancelled_at IS NULL OR (cancelled_at GLOB '????-??-??T??:??:??.???Z' AND julianday(cancelled_at) IS NOT NULL)),
      score_event_id INTEGER UNIQUE REFERENCES score_events(id) ON DELETE RESTRICT,
      evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
      UNIQUE(season_id,challenge_definition_id,season_member_id),
      CHECK((status='pending' AND completed_at IS NULL AND cancelled_at IS NULL AND score_event_id IS NULL)
        OR (status='completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND score_event_id IS NOT NULL)
        OR (status='cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL AND score_event_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_challenge_assignments_season_status ON challenge_assignments(season_id,status,id);
    CREATE INDEX IF NOT EXISTS idx_challenge_assignments_member ON challenge_assignments(season_member_id,status,id);

    CREATE TRIGGER IF NOT EXISTS trg_challenge_definitions_owner_insert
    BEFORE INSERT ON challenge_definitions
    WHEN NOT EXISTS (SELECT 1 FROM leagues l WHERE l.id=NEW.league_id AND (l.owner_user_id=NEW.created_by_user_id
      OR EXISTS (SELECT 1 FROM league_memberships m WHERE m.league_id=l.id AND m.user_id=NEW.created_by_user_id AND m.left_at IS NULL AND m.role='admin')))
    BEGIN SELECT RAISE(ABORT,'challenge definition creator membership mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_challenge_assignments_insert
    BEFORE INSERT ON challenge_assignments
    WHEN NOT EXISTS (SELECT 1 FROM seasons s JOIN challenge_definitions d ON d.id=NEW.challenge_definition_id
      JOIN season_members sm ON sm.id=NEW.season_member_id
      WHERE s.id=NEW.season_id AND d.league_id=s.league_id AND sm.season_id=s.id
        AND NEW.challenge_slug_snapshot=d.slug AND NEW.challenge_title_snapshot=d.title
        AND NEW.challenge_description_snapshot IS d.description AND NEW.challenge_points_snapshot=d.points
        AND NEW.challenge_rule_version_snapshot=d.rule_version
        AND s.mode='challenge' AND s.participants_locked_at IS NOT NULL AND s.cancelled_at IS NULL AND s.finalized_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM leagues l WHERE l.id=s.league_id AND l.archived_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'challenge assignment season or participant mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_challenge_assignments_completion_update
    BEFORE UPDATE OF status,completed_at,cancelled_at,score_event_id ON challenge_assignments
    WHEN NEW.status='completed' AND NOT EXISTS (SELECT 1 FROM score_events e JOIN season_members sm ON sm.id=NEW.season_member_id
      WHERE e.id=NEW.score_event_id AND e.user_id=sm.user_id AND e.season_id=NEW.season_id AND e.season_member_id=NEW.season_member_id
        AND e.category='challenge_bonus' AND e.points=NEW.challenge_points_snapshot AND e.rule_version=NEW.challenge_rule_version_snapshot
        AND e.reverses_event_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'challenge completion score event mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_challenge_assignments_identity_immutable
    BEFORE UPDATE OF season_id,challenge_definition_id,season_member_id,assigned_by_user_id,assigned_at,
      challenge_slug_snapshot,challenge_title_snapshot,challenge_description_snapshot,challenge_points_snapshot,challenge_rule_version_snapshot
    ON challenge_assignments
    WHEN NEW.season_id IS NOT OLD.season_id OR NEW.challenge_definition_id IS NOT OLD.challenge_definition_id
      OR NEW.season_member_id IS NOT OLD.season_member_id OR NEW.assigned_by_user_id IS NOT OLD.assigned_by_user_id
      OR NEW.assigned_at IS NOT OLD.assigned_at OR NEW.challenge_slug_snapshot IS NOT OLD.challenge_slug_snapshot
      OR NEW.challenge_title_snapshot IS NOT OLD.challenge_title_snapshot OR NEW.challenge_description_snapshot IS NOT OLD.challenge_description_snapshot
      OR NEW.challenge_points_snapshot IS NOT OLD.challenge_points_snapshot OR NEW.challenge_rule_version_snapshot IS NOT OLD.challenge_rule_version_snapshot
    BEGIN SELECT RAISE(ABORT,'challenge assignment identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_challenge_assignments_frozen_update
    BEFORE UPDATE OF status,completed_at,cancelled_at,score_event_id,evidence_json ON challenge_assignments
    WHEN EXISTS (SELECT 1 FROM seasons s JOIN leagues l ON l.id=s.league_id
      WHERE s.id=OLD.season_id AND (s.cancelled_at IS NOT NULL OR s.finalized_at IS NOT NULL OR l.archived_at IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'challenge assignment season is frozen'); END;

    CREATE TRIGGER IF NOT EXISTS trg_challenge_assignments_delete
    BEFORE DELETE ON challenge_assignments
    BEGIN SELECT RAISE(ABORT,'challenge assignments are immutable'); END;
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (13)").run();
}

// Owner-controlled diary annotations and same-owner append-only audit.
function migration14() {
  // Schema 7 allowed only one lifetime case per provider event. Diary date edits
  // can create distinct review episodes, so preserve history and constrain only
  // the single currently active episode. Preserve triggers on other tables that
  // query duplicate_cases while rebuilding the table.
  const dependentDuplicateTriggers = db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE type='trigger' AND tbl_name<>'duplicate_cases' AND sql LIKE '%duplicate_cases%'`).all();
  for (const trigger of dependentDuplicateTriggers) {
    const quoted = `"${trigger.name.replaceAll('"', '""')}"`;
    db.exec(`DROP TRIGGER ${quoted}`);
  }
  db.exec(`
    CREATE TABLE duplicate_cases_v14 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      canonical_watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE RESTRICT,
      candidate_watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
      resolution TEXT CHECK(resolution IN ('merge','keep_both','keep_separate','ignore_future_matching')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      CHECK(canonical_watch_id <> candidate_watch_id),
      CHECK((status='pending' AND resolution IS NULL AND resolved_at IS NULL) OR
            (status='resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL))
    );
    INSERT INTO duplicate_cases_v14
      (id,user_id,fingerprint,canonical_watch_id,candidate_watch_id,status,resolution,evidence_json,created_at,resolved_at,cancelled_at,cancellation_reason)
      SELECT id,user_id,fingerprint,canonical_watch_id,candidate_watch_id,status,resolution,evidence_json,created_at,resolved_at,cancelled_at,cancellation_reason
      FROM duplicate_cases;
    DROP TABLE duplicate_cases;
    ALTER TABLE duplicate_cases_v14 RENAME TO duplicate_cases;
    CREATE INDEX idx_duplicate_cases_user_status ON duplicate_cases(user_id,status,created_at,id);
    CREATE INDEX idx_duplicate_cases_fingerprint ON duplicate_cases(user_id,fingerprint,status,id);
    CREATE UNIQUE INDEX idx_duplicate_cases_active_candidate ON duplicate_cases(candidate_watch_id) WHERE cancelled_at IS NULL;
    CREATE TRIGGER trg_duplicate_cases_owner_insert
      BEFORE INSERT ON duplicate_cases
      WHEN NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.canonical_watch_id AND w.user_id=NEW.user_id)
        OR NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.candidate_watch_id AND w.user_id=NEW.user_id)
      BEGIN SELECT RAISE(ABORT,'duplicate case owner mismatch'); END;
    CREATE TRIGGER trg_duplicate_cases_owner_update
      BEFORE UPDATE OF user_id,canonical_watch_id,candidate_watch_id ON duplicate_cases
      WHEN NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.canonical_watch_id AND w.user_id=NEW.user_id)
        OR NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.candidate_watch_id AND w.user_id=NEW.user_id)
      BEGIN SELECT RAISE(ABORT,'duplicate case owner mismatch'); END;
  `);
  for (const trigger of dependentDuplicateTriggers) db.exec(trigger.sql);

  const columns = [
    ["personal_rating", "BLOB CHECK(personal_rating IS NULL OR (typeof(personal_rating)='integer' AND personal_rating BETWEEN 0 AND 100))"],
    ["review", "TEXT CHECK(review IS NULL OR length(review)<=5000)"], ["private_notes", "TEXT CHECK(private_notes IS NULL OR length(private_notes)<=10000)"],
    ["favorite", "INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1))"],
    ["tags_json", "TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json)='array' AND length(tags_json)<=2000)"],
    ["venue", "TEXT CHECK(venue IS NULL OR length(venue)<=200)"], ["visibility", "TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','friends','public'))"],
  ];
  for (const [name, definition] of columns) if (!columnExists("watches", name)) db.exec(`ALTER TABLE watches ADD COLUMN ${name} ${definition}`);
  db.exec(`CREATE TABLE IF NOT EXISTS watch_annotation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE RESTRICT,
      changed_fields_json TEXT NOT NULL CHECK(json_valid(changed_fields_json) AND json_type(changed_fields_json)='array'),
      before_json TEXT NOT NULL CHECK(json_valid(before_json) AND json_type(before_json)='object'),
      after_json TEXT NOT NULL CHECK(json_valid(after_json) AND json_type(after_json)='object'),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE INDEX IF NOT EXISTS idx_watch_annotation_audit_watch ON watch_annotation_audit(user_id,watch_id,id);
    CREATE TRIGGER IF NOT EXISTS trg_watch_annotation_audit_owner_insert BEFORE INSERT ON watch_annotation_audit
      WHEN NOT EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.watch_id AND w.user_id=NEW.user_id)
      BEGIN SELECT RAISE(ABORT,'watch annotation audit owner mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watch_annotation_audit_same_id_insert BEFORE INSERT ON watch_annotation_audit
      WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM watch_annotation_audit a WHERE a.id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'watch annotation audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watch_annotation_audit_update BEFORE UPDATE ON watch_annotation_audit
      BEGIN SELECT RAISE(ABORT,'watch annotation audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watch_annotation_audit_delete BEFORE DELETE ON watch_annotation_audit
      BEGIN SELECT RAISE(ABORT,'watch annotation audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watches_diary_owner_update BEFORE UPDATE OF user_id ON watches
      WHEN EXISTS (SELECT 1 FROM watch_annotation_audit a WHERE a.watch_id=OLD.id AND a.user_id<>NEW.user_id)
      BEGIN SELECT RAISE(ABORT,'watch owner has dependent diary audit records'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watches_diary_rating_insert BEFORE INSERT ON watches
      WHEN NEW.personal_rating IS NOT NULL AND (typeof(NEW.personal_rating)<>'integer' OR NEW.personal_rating NOT BETWEEN 0 AND 100)
      BEGIN SELECT RAISE(ABORT,'personal_rating must be an integer from 0 to 100'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watches_diary_rating_update BEFORE UPDATE OF personal_rating ON watches
      WHEN NEW.personal_rating IS NOT NULL AND (typeof(NEW.personal_rating)<>'integer' OR NEW.personal_rating NOT BETWEEN 0 AND 100)
      BEGIN SELECT RAISE(ABORT,'personal_rating must be an integer from 0 to 100'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watches_diary_tags_insert BEFORE INSERT ON watches
      WHEN NOT (json_valid(NEW.tags_json) AND json_type(NEW.tags_json)='array')
        OR (json_valid(NEW.tags_json) AND json_type(NEW.tags_json)='array' AND (
          json_array_length(NEW.tags_json)>20
          OR EXISTS (SELECT 1 FROM json_each(NEW.tags_json) j WHERE j.type<>'text' OR length(j.value) NOT BETWEEN 1 AND 30
            OR j.value<>trim(j.value) OR j.value<>lower(j.value) OR substr(j.value,1,1) NOT GLOB '[a-z0-9]'
            OR j.value GLOB '*[^a-z0-9 _-]*')
          OR EXISTS (SELECT 1 FROM json_each(NEW.tags_json) a JOIN json_each(NEW.tags_json) b ON a.key<b.key WHERE a.value>=b.value)))
      BEGIN SELECT RAISE(ABORT,'tags_json must contain canonical tags'); END;
    CREATE TRIGGER IF NOT EXISTS trg_watches_diary_tags_update BEFORE UPDATE OF tags_json ON watches
      WHEN NOT (json_valid(NEW.tags_json) AND json_type(NEW.tags_json)='array')
        OR (json_valid(NEW.tags_json) AND json_type(NEW.tags_json)='array' AND (
          json_array_length(NEW.tags_json)>20
          OR EXISTS (SELECT 1 FROM json_each(NEW.tags_json) j WHERE j.type<>'text' OR length(j.value) NOT BETWEEN 1 AND 30
            OR j.value<>trim(j.value) OR j.value<>lower(j.value) OR substr(j.value,1,1) NOT GLOB '[a-z0-9]'
            OR j.value GLOB '*[^a-z0-9 _-]*')
          OR EXISTS (SELECT 1 FROM json_each(NEW.tags_json) a JOIN json_each(NEW.tags_json) b ON a.key<b.key WHERE a.value>=b.value)))
      BEGIN SELECT RAISE(ABORT,'tags_json must contain canonical tags'); END;`);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (14)").run();
}

// Durable, private provenance for user-supplied Letterboxd history.
function migration15() {
  const columns = [
    ["competition_eligibility", "TEXT NOT NULL DEFAULT 'eligible' CHECK(competition_eligibility IN ('eligible','unverified_import'))"],
    ["source_recorded_date", "TEXT"],
    ["source_date_kind", "TEXT CHECK(source_date_kind IS NULL OR source_date_kind IN ('watched_day','marked_watched_day'))"],
    ["import_source", "TEXT"],
    ["import_event_key", "TEXT"],
  ];
  for (const [name, definition] of columns) {
    if (!columnExists("watches", name)) db.exec(`ALTER TABLE watches ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_import_identity
      ON watches(user_id,import_source,import_event_key)
      WHERE import_source IS NOT NULL AND import_event_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS letterboxd_import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_job_id TEXT NOT NULL CHECK(length(trim(public_job_id)) BETWEEN 16 AND 128),
      file_digest TEXT NOT NULL CHECK(length(file_digest)=64 AND file_digest NOT GLOB '*[^0-9a-f]*'),
      diary_file_sha256 TEXT CHECK(diary_file_sha256 IS NULL OR
        (length(diary_file_sha256)=64 AND diary_file_sha256 NOT GLOB '*[^0-9a-f]*')),
      watched_file_sha256 TEXT CHECK(watched_file_sha256 IS NULL OR
        (length(watched_file_sha256)=64 AND watched_file_sha256 NOT GLOB '*[^0-9a-f]*')),
      commit_token_hash TEXT NOT NULL CHECK(length(commit_token_hash)=64 AND commit_token_hash NOT GLOB '*[^0-9a-f]*'),
      state TEXT NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','committing','completed','failed')),
      decision_hash TEXT CHECK(decision_hash IS NULL OR
        (length(decision_hash)=64 AND decision_hash NOT GLOB '*[^0-9a-f]*')),
      row_count INTEGER NOT NULL CHECK(typeof(row_count)='integer' AND row_count BETWEEN 1 AND 10000),
      resolved_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(resolved_count)='integer' AND resolved_count BETWEEN 0 AND row_count),
      error_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(error_count)='integer' AND error_count BETWEEN 0 AND row_count),
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object')),
      expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(expires_at) IS NOT NULL),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        CHECK(updated_at GLOB '????-??-??T??:??:??.???Z' AND julianday(updated_at) IS NOT NULL),
      commit_token_consumed_at TEXT CHECK(commit_token_consumed_at IS NULL OR
        (commit_token_consumed_at GLOB '????-??-??T??:??:??.???Z' AND julianday(commit_token_consumed_at) IS NOT NULL)),
      completed_at TEXT CHECK(completed_at IS NULL OR
        (completed_at GLOB '????-??-??T??:??:??.???Z' AND julianday(completed_at) IS NOT NULL)),
      error TEXT CHECK(error IS NULL OR length(error)<=1000),
      UNIQUE(user_id,public_job_id),
      UNIQUE(user_id,file_digest),
      UNIQUE(user_id,commit_token_hash),
      CHECK(diary_file_sha256 IS NOT NULL OR watched_file_sha256 IS NOT NULL),
      CHECK(error_count<=row_count-resolved_count OR state IN ('completed','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_letterboxd_import_jobs_owner_state
      ON letterboxd_import_jobs(user_id,state,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_letterboxd_import_jobs_expiry
      ON letterboxd_import_jobs(expires_at) WHERE state='preview';

    CREATE TABLE IF NOT EXISTS letterboxd_import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES letterboxd_import_jobs(id) ON DELETE CASCADE,
      source_row_number INTEGER NOT NULL CHECK(typeof(source_row_number)='integer' AND source_row_number BETWEEN 2 AND 10001),
      file_kind TEXT NOT NULL CHECK(file_kind IN ('diary','watched')),
      row_snapshot_json TEXT NOT NULL CHECK(json_valid(row_snapshot_json) AND json_type(row_snapshot_json)='object' AND length(row_snapshot_json)<=20000),
      source_recorded_date TEXT,
      source_date_kind TEXT NOT NULL CHECK(source_date_kind IN ('watched_day','marked_watched_day')),
      import_event_key TEXT NOT NULL CHECK(length(trim(import_event_key)) BETWEEN 1 AND 1000),
      resolution_state TEXT NOT NULL DEFAULT 'unresolved' CHECK(resolution_state IN
        ('unresolved','auto_selected','choice_required','selected','skipped','invalid','imported','already_imported','error')),
      candidate_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(candidate_json) AND json_type(candidate_json)='array' AND length(candidate_json)<=50000),
      selected_tmdb_id INTEGER CHECK(selected_tmdb_id IS NULL OR (typeof(selected_tmdb_id)='integer' AND selected_tmdb_id>0)),
      watch_id INTEGER REFERENCES watches(id) ON DELETE RESTRICT,
      error TEXT CHECK(error IS NULL OR length(error)<=1000),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(job_id,file_kind,source_row_number),
      UNIQUE(job_id,import_event_key),
      CHECK((resolution_state='invalid' AND source_recorded_date IS NULL) OR
        (resolution_state<>'invalid' AND source_recorded_date IS NOT NULL AND length(source_recorded_date)=10 AND
         source_recorded_date GLOB '????-??-??' AND date(source_recorded_date,'+0 days')=source_recorded_date))
    );
    CREATE INDEX IF NOT EXISTS idx_letterboxd_import_rows_job_state
      ON letterboxd_import_rows(job_id,resolution_state,id);

    CREATE TRIGGER IF NOT EXISTS trg_letterboxd_import_rows_watch_insert
    BEFORE INSERT ON letterboxd_import_rows
    WHEN NEW.watch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM letterboxd_import_jobs job JOIN watches watch ON watch.id=NEW.watch_id
      WHERE job.id=NEW.job_id AND job.user_id=watch.user_id AND NEW.selected_tmdb_id=watch.tmdb_id
    )
    BEGIN SELECT RAISE(ABORT,'import row owner or movie mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_letterboxd_import_rows_watch_update
    BEFORE UPDATE OF job_id,selected_tmdb_id,watch_id ON letterboxd_import_rows
    WHEN NEW.watch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM letterboxd_import_jobs job JOIN watches watch ON watch.id=NEW.watch_id
      WHERE job.id=NEW.job_id AND job.user_id=watch.user_id AND NEW.selected_tmdb_id=watch.tmdb_id
    )
    BEGIN SELECT RAISE(ABORT,'import row owner or movie mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS trg_watches_unverified_import_insert
    BEFORE INSERT ON watches
    WHEN (NEW.source='letterboxd' AND NEW.competition_eligibility<>'unverified_import')
      OR (NEW.competition_eligibility='unverified_import' AND (
        NEW.source<>'letterboxd' OR NEW.points<>0 OR NEW.qualifies_for_volume<>0 OR NEW.qualifies_for_achievement<>0
        OR NEW.qualifies_for_streak<>0 OR NEW.qualifies_for_season<>0 OR NEW.visibility<>'private'
        OR NEW.provider_service IS NOT NULL OR NEW.provider_connection_id IS NOT NULL OR NEW.provider_event_id IS NOT NULL
        OR NEW.import_source IS NULL OR NEW.import_source<>trim(NEW.import_source) OR NEW.import_source<>'letterboxd'
        OR NEW.import_event_key IS NULL OR length(trim(NEW.import_event_key)) NOT BETWEEN 1 AND 1000
        OR NEW.source_recorded_date IS NULL OR length(NEW.source_recorded_date)<>10
        OR NEW.source_recorded_date NOT GLOB '????-??-??'
        OR date(NEW.source_recorded_date,'+0 days') IS NOT NEW.source_recorded_date
        OR NEW.source_date_kind IS NULL OR NEW.source_date_kind NOT IN ('watched_day','marked_watched_day')
      )) OR (NEW.competition_eligibility<>'unverified_import' AND (
        NEW.import_source IS NOT NULL OR NEW.import_event_key IS NOT NULL
        OR NEW.source_recorded_date IS NOT NULL OR NEW.source_date_kind IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'unverified import integrity violation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_watches_unverified_import_update
    BEFORE UPDATE ON watches
    WHEN NEW.competition_eligibility IS NOT OLD.competition_eligibility
      OR (OLD.competition_eligibility='unverified_import' AND (
        NEW.user_id IS NOT OLD.user_id OR NEW.source IS NOT OLD.source
        OR NEW.source_recorded_date IS NOT OLD.source_recorded_date
        OR NEW.source_date_kind IS NOT OLD.source_date_kind
        OR NEW.import_source IS NOT OLD.import_source OR NEW.import_event_key IS NOT OLD.import_event_key
      ))
      OR (NEW.source='letterboxd' AND NEW.competition_eligibility<>'unverified_import')
      OR (NEW.competition_eligibility='unverified_import' AND (
        NEW.source<>'letterboxd' OR NEW.points<>0 OR NEW.qualifies_for_volume<>0 OR NEW.qualifies_for_achievement<>0
        OR NEW.qualifies_for_streak<>0 OR NEW.qualifies_for_season<>0 OR NEW.visibility<>'private'
        OR NEW.provider_service IS NOT NULL OR NEW.provider_connection_id IS NOT NULL OR NEW.provider_event_id IS NOT NULL
        OR NEW.import_source IS NULL OR NEW.import_source<>trim(NEW.import_source) OR NEW.import_source<>'letterboxd'
        OR NEW.import_event_key IS NULL OR length(trim(NEW.import_event_key)) NOT BETWEEN 1 AND 1000
        OR NEW.source_recorded_date IS NULL OR length(NEW.source_recorded_date)<>10
        OR NEW.source_recorded_date NOT GLOB '????-??-??'
        OR date(NEW.source_recorded_date,'+0 days') IS NOT NEW.source_recorded_date
        OR NEW.source_date_kind IS NULL OR NEW.source_date_kind NOT IN ('watched_day','marked_watched_day')
      )) OR (NEW.competition_eligibility<>'unverified_import' AND (
        NEW.import_source IS NOT NULL OR NEW.import_event_key IS NOT NULL
        OR NEW.source_recorded_date IS NOT NULL OR NEW.source_date_kind IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'unverified import integrity violation'); END;

    CREATE TRIGGER IF NOT EXISTS trg_score_events_unverified_watch_insert
    BEFORE INSERT ON score_events
    WHEN NEW.watch_id IS NOT NULL AND NEW.reverses_event_id IS NULL
      AND EXISTS (SELECT 1 FROM watches w WHERE w.id=NEW.watch_id AND w.competition_eligibility='unverified_import')
    BEGIN SELECT RAISE(ABORT,'unverified import cannot have a root score event'); END;

    CREATE TRIGGER IF NOT EXISTS trg_letterboxd_import_jobs_identity_update
    BEFORE UPDATE OF user_id,public_job_id,file_digest,diary_file_sha256,watched_file_sha256,commit_token_hash,row_count
    ON letterboxd_import_jobs
    WHEN NEW.user_id IS NOT OLD.user_id OR NEW.public_job_id IS NOT OLD.public_job_id
      OR NEW.file_digest IS NOT OLD.file_digest OR NEW.diary_file_sha256 IS NOT OLD.diary_file_sha256
      OR NEW.watched_file_sha256 IS NOT OLD.watched_file_sha256
      OR NEW.commit_token_hash IS NOT OLD.commit_token_hash OR NEW.row_count IS NOT OLD.row_count
    BEGIN SELECT RAISE(ABORT,'import job identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_letterboxd_import_jobs_token_reuse
    BEFORE UPDATE OF commit_token_consumed_at ON letterboxd_import_jobs
    WHEN OLD.commit_token_consumed_at IS NOT NULL AND NEW.commit_token_consumed_at IS NOT OLD.commit_token_consumed_at
    BEGIN SELECT RAISE(ABORT,'Letterboxd import commit token is one-use'); END;
  `);
  db.prepare("INSERT OR IGNORE INTO schema_versions (version) VALUES (15)").run();
}

// ---------------------------------------------------------------------------
// Public: run all pending migrations
// ---------------------------------------------------------------------------

export function runMigrations({ skipBackup = false, targetVersion = 15 } = {}) {
  const latestVersion = 15;
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
    const applicationTables = db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND substr(name,1,7)<>'sqlite_' AND name<>'schema_versions'`).all();
    const hasApplicationRows = applicationTables.some(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return Boolean(db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get());
    });
    if (hasApplicationRows) {
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
  if (targetVersion >= 9 && !applied.has(9)) {
    db.transaction(migration9)();
  }
  if (targetVersion >= 10 && !applied.has(10)) {
    db.transaction(migration10)();
  }
  if (targetVersion >= 11 && !applied.has(11)) {
    db.transaction(migration11)();
  }
  if (targetVersion >= 12 && !applied.has(12)) {
    db.transaction(migration12)();
  }
  if (targetVersion >= 13 && !applied.has(13)) {
    db.transaction(migration13)();
  }
  if (targetVersion >= 14 && !applied.has(14)) {
    db.transaction(migration14)();
  }
  if (targetVersion >= 15 && !applied.has(15)) {
    db.transaction(migration15)();
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
