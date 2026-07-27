import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "reelscore.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
  genres TEXT,              -- JSON array of genre names
  collection_id INTEGER,    -- TMDB collection (series) id, if any
  collection_name TEXT,
  points INTEGER NOT NULL,
  is_rewatch INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | plex | trakt (future)
  watched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id, watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watches_user_movie ON watches(user_id, tmdb_id);

CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,        -- unique achievement key, e.g. genre:Horror:25
  name TEXT NOT NULL,
  description TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, key)
);

CREATE TABLE IF NOT EXISTS connections (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,               -- plex | trakt
  access_token TEXT,
  refresh_token TEXT,
  server_url TEXT,                     -- plex only
  service_username TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT,
  PRIMARY KEY (user_id, service)
);

CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  requested_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, friend_id)
);
`);

export function totalScore(userId) {
  const w = db
    .prepare("SELECT COALESCE(SUM(points),0) s FROM watches WHERE user_id = ?")
    .get(userId).s;
  const a = db
    .prepare("SELECT COALESCE(SUM(points),0) s FROM achievements WHERE user_id = ?")
    .get(userId).s;
  return w + a;
}

export function watchCount(userId) {
  return db.prepare("SELECT COUNT(*) c FROM watches WHERE user_id = ?").get(userId).c;
}

// Current streak: consecutive days (ending today or yesterday) with >= 1 watch.
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
