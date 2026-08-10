import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const dbModule = pathToFileURL(path.resolve("src/db.js")).href;
const secret = "test-secret-that-is-at-least-32-chars-long";

function runModule(dataDir, suffix, statements) {
  const source = `
    process.env.DATA_DIR=${JSON.stringify(dataDir)};
    process.env.NODE_ENV='test';
    process.env.SESSION_SECRET=${JSON.stringify(secret)};
    const module = await import(${JSON.stringify(`${dbModule}?case=${suffix}`)});
    ${statements}
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test", SESSION_SECRET: secret },
  });
}

function createExactV6(dataDir, suffix) {
  const run = runModule(dataDir, suffix, `
    module.initializeDatabase({ targetVersion: 6 });
    module.db.prepare("INSERT INTO users(id,username,password_hash) VALUES (1,'v6-user','x')").run();
    module.db.prepare("INSERT INTO watches(id,user_id,tmdb_id,title,points,watched_at) VALUES (1,1,42,'Zero legacy watch',0,'2024-01-01 00:00:00')").run();
    module.db.prepare("INSERT INTO achievements(id,user_id,key,name,points) VALUES (1,1,'legacy:test','Legacy achievement',5)").run();
  `);
  assert.equal(run.status, 0, run.stderr);
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rs-${name}-`));
}

test("migration 7 initializes a fresh database", () => {
  const dataDir = tempDir("fresh-v7");
  const run = runModule(dataDir, "fresh", "module.initializeDatabase();");
  assert.equal(run.status, 0, run.stderr);
  const database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.ok(database.prepare("SELECT 1 FROM schema_versions WHERE version=7").get());
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='score_events'").get());
  database.close();
});

test("migration 7 upgrades the exact schema produced by migrations 0 through 6", () => {
  const dataDir = tempDir("v6-v7");
  createExactV6(dataDir, "build-v6");
  let database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.equal(database.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 6);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mfa_login_challenges'").get());
  assert.equal(new Set(database.prepare("PRAGMA table_info(users)").all().map((row) => row.name)).has("timezone"), false);
  database.close();

  const run = runModule(dataDir, "upgrade-v7", "module.initializeDatabase();");
  assert.equal(run.status, 0, run.stderr);
  database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.ok(database.prepare("SELECT 1 FROM schema_versions WHERE version=7").get());
  assert.deepEqual(database.prepare("SELECT watch_id,points FROM score_events WHERE event_key='legacy/watch/1'").get(), { watch_id: 1, points: 0 });
  assert.equal(database.prepare("SELECT SUM(points) total FROM score_events WHERE user_id=1").get().total, 5);
  database.close();
});

test("migration 7 invariant failure rolls back schema and version atomically", () => {
  const dataDir = tempDir("v7-rollback");
  createExactV6(dataDir, "build-v6-rollback");
  let database = new Database(path.join(dataDir, "reelscore.db"));
  database.exec(`
    CREATE TABLE score_events (
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
      reverses_event_id INTEGER UNIQUE REFERENCES score_events(id) ON DELETE RESTRICT
    );
    INSERT INTO score_events(event_key,user_id,category,points,rule_version)
      VALUES ('legacy/watch/1',1,'legacy_watch',0,'legacy-v1');
  `);
  database.close();

  const run = runModule(dataDir, "rollback-v7", "module.initializeDatabase();");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /source-exact legacy event check failed/i);
  database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.equal(database.prepare("SELECT 1 FROM schema_versions WHERE version=7").get(), undefined);
  assert.equal(new Set(database.prepare("PRAGMA table_info(users)").all().map((row) => row.name)).has("timezone"), false);
  assert.equal(new Set(database.prepare("PRAGMA table_info(watches)").all().map((row) => row.name)).has("watched_at_utc"), false);
  database.close();
});
