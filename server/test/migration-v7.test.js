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

function createExactV8(dataDir, suffix, extraStatements = "") {
  const run = runModule(dataDir, suffix, `
    module.initializeDatabase({ targetVersion: 8 });
    module.db.prepare("INSERT INTO users(id,username,password_hash) VALUES (1,'v8-owner','x'),(2,'v8-member','x'),(3,'v8-other','x')").run();
    module.db.prepare("INSERT INTO watches(id,user_id,tmdb_id,title,points,watched_at,watched_at_utc,watched_day_local,timezone_used) VALUES (1,2,42,'V8 watch',17,'2028-01-02 03:04:05','2028-01-02T03:04:05.000Z','2028-01-02','UTC')").run();
    module.db.prepare("INSERT INTO score_events(id,event_key,user_id,watch_id,category,points,rule_version,metadata_json,created_at) VALUES (1,'v8/watch/1',2,1,'watch_first',17,'competition-v1',json_object('fixture',json('true')),'2028-01-02T03:04:05.000Z')").run();
    ${extraStatements}
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


test("schema-6 automatic snapshot restores and migrates to schema 10", () => {
  const sourceDir = tempDir("v6-snapshot-source");
  createExactV6(sourceDir, "build-v6-snapshot");
  const migrated = runModule(sourceDir, "migrate-v6-snapshot", "module.initializeDatabase();");
  assert.equal(migrated.status, 0, migrated.stderr);
  const backupsDir = path.join(sourceDir, "backups");
  const snapshots = fs.readdirSync(backupsDir).filter((name) => name.endsWith(".db"));
  assert.equal(snapshots.length, 1);
  const snapshotPath = path.join(backupsDir, snapshots[0]);
  let snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  assert.equal(snapshot.pragma("integrity_check")[0].integrity_check, "ok");
  assert.equal(snapshot.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 6);
  assert.equal(snapshot.prepare("SELECT COUNT(*) count FROM users").get().count, 1);
  assert.equal(snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='score_events'").get(), undefined);
  snapshot.close();

  const restoreDir = tempDir("v6-snapshot-restore");
  fs.copyFileSync(snapshotPath, path.join(restoreDir, "reelscore.db"));
  const restored = runModule(restoreDir, "restore-v6-to-v9", "module.initializeDatabase();");
  assert.equal(restored.status, 0, restored.stderr);
  snapshot = new Database(path.join(restoreDir, "reelscore.db"), { readonly: true, fileMustExist: true });
  assert.equal(snapshot.pragma("integrity_check")[0].integrity_check, "ok");
  assert.equal(snapshot.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 10);
  assert.equal(snapshot.prepare("SELECT COUNT(*) count FROM users").get().count, 1);
  assert.equal(snapshot.prepare("SELECT COUNT(*) count FROM watches").get().count, 1);
  assert.equal(snapshot.prepare("SELECT COUNT(*) count FROM achievements").get().count, 1);
  snapshot.close();
});


test("migration 9 initializes the league and season integrity schema", () => {
  const dataDir = tempDir("fresh-v9");
  const run = runModule(dataDir, "fresh-v9", "module.initializeDatabase();");
  assert.equal(run.status, 0, run.stderr);
  const database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.ok(database.prepare("SELECT 1 FROM schema_versions WHERE version=9").get());
  for (const table of ["leagues", "league_memberships", "league_invites", "league_invite_uses", "seasons", "season_members"]) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  const leagueColumns = new Map(database.prepare("PRAGMA table_info(leagues)").all().map((row) => [row.name, row]));
  assert.equal(leagueColumns.get("owner_user_id").notnull, 1);
  const scoreColumns = new Set(database.prepare("PRAGMA table_info(score_events)").all().map((row) => row.name));
  assert.ok(scoreColumns.has("effective_at"));
  assert.ok(scoreColumns.has("projection_source_event_id"));
  assert.ok(scoreColumns.has("season_member_id"));
  const scoreForeignKeys = new Set(database.prepare("PRAGMA foreign_key_list(score_events)").all().map((row) => row.table));
  assert.ok(scoreForeignKeys.has("score_events"));
  assert.ok(scoreForeignKeys.has("season_members"));
  database.close();
});

test("migration 9 upgrades exact schema 8 additively, creates a backup, and is idempotent", () => {
  const dataDir = tempDir("v8-v9");
  createExactV8(dataDir, "build-v8");
  const dbPath = path.join(dataDir, "reelscore.db");
  let database = new Database(dbPath, { readonly: true });
  const beforeScoreColumns = database.prepare("PRAGMA table_info(score_events)").all().map((row) => row.name);
  const preservedTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_versions','score_events') ORDER BY name").all().map((row) => row.name);
  const beforeRows = Object.fromEntries(preservedTables.map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
  const baseColumns = "id,event_key,user_id,watch_id,achievement_id,season_id,category,points,rule_version,metadata_json,created_at,reversed_at,reverses_event_id";
  const before = database.prepare(`SELECT ${baseColumns} FROM score_events ORDER BY id`).all();
  const beforeTotal = database.prepare("SELECT SUM(points) total FROM score_events WHERE season_id IS NULL").get().total;
  database.close();
  const upgraded = runModule(dataDir, "upgrade-v9", "module.initializeDatabase(); module.runMigrations();");
  assert.equal(upgraded.status, 0, upgraded.stderr);
  database = new Database(dbPath, { readonly: true });
  assert.deepEqual(database.prepare("PRAGMA table_info(score_events)").all().map((row) => row.name),
    [...beforeScoreColumns, "effective_at", "projection_source_event_id", "season_member_id"]);
  assert.deepEqual(database.prepare(`SELECT ${baseColumns} FROM score_events ORDER BY id`).all(), before);
  for (const table of preservedTables) assert.deepEqual(database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(), beforeRows[table], table);
  assert.deepEqual(database.prepare("SELECT effective_at,created_at FROM score_events ORDER BY id").all(),
    before.map((row) => ({ effective_at: row.created_at, created_at: row.created_at })));
  assert.equal(database.prepare("SELECT SUM(points) total FROM score_events WHERE season_id IS NULL").get().total, beforeTotal);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM schema_versions WHERE version=9").get().count, 1);
  assert.deepEqual(database.pragma("foreign_key_check"), []);
  database.close();
  const snapshots = fs.readdirSync(path.join(dataDir, "backups")).filter((name) => name.endsWith(".db"));
  assert.equal(snapshots.length, 1);
  const backup = new Database(path.join(dataDir, "backups", snapshots[0]), { readonly: true });
  assert.equal(backup.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 8);
  backup.close();
});

test("migration 9 canonicalizes supported legacy score timestamps", () => {
  const dataDir = tempDir("v9-legacy-time");
  createExactV8(dataDir, "build-v8-legacy-time", "module.db.prepare(\"UPDATE score_events SET created_at='2028-01-02 03:04:05' WHERE id=1\").run();");
  const run = runModule(dataDir, "upgrade-v9-legacy-time", "module.initializeDatabase();");
  assert.equal(run.status, 0, run.stderr);
  const database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  const event = database.prepare("SELECT created_at,effective_at FROM score_events WHERE id=1").get();
  assert.equal(event.created_at, "2028-01-02 03:04:05");
  assert.equal(event.effective_at, "2028-01-02T03:04:05.000Z");
  database.close();
});

test("migration 9 rejects impossible legacy score timestamps and rolls back", () => {
  const dataDir = tempDir("v9-invalid-time");
  createExactV8(dataDir, "build-v8-invalid-time", "module.db.prepare(\"UPDATE score_events SET created_at='2028-02-30 03:04:05' WHERE id=1\").run();");
  const run = runModule(dataDir, "upgrade-v9-invalid-time", "module.initializeDatabase();");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /invalid UTC instant|effective time/i);
  const database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.equal(database.prepare("SELECT 1 FROM schema_versions WHERE version=9").get(), undefined);
  assert.equal(new Set(database.prepare("PRAGMA table_info(score_events)").all().map((row) => row.name)).has("effective_at"), false);
  database.close();
});

test("migration 9 rejects a pre-existing orphan season id and rolls back atomically", () => {
  const dataDir = tempDir("v9-orphan");
  createExactV8(dataDir, "build-v8-orphan", "module.db.prepare(\"UPDATE score_events SET season_id=999 WHERE id=1\").run();");
  const run = runModule(dataDir, "upgrade-v9-orphan", "module.initializeDatabase();");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /orphan.*season/i);
  const database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.equal(database.prepare("SELECT 1 FROM schema_versions WHERE version=9").get(), undefined);
  assert.equal(new Set(database.prepare("PRAGMA table_info(score_events)").all().map((row) => row.name)).has("projection_source_event_id"), false);
  assert.equal(database.prepare("SELECT season_id FROM score_events WHERE id=1").get().season_id, 999);
  database.close();
});



test("migration 10 upgrades an already-recorded schema 9 and restores reversal guards", () => {
  const dataDir = tempDir("v9-v10");
  const build = runModule(dataDir, "build-prior-v9", `
    module.initializeDatabase({ targetVersion: 9 });
    module.db.prepare("INSERT INTO users(id,username,password_hash) VALUES (1,'prior-v9','x')").run();
    module.db.prepare("INSERT INTO watches(id,user_id,tmdb_id,title,points,watched_at,watched_at_utc,watched_day_local,timezone_used,qualifies_for_season) VALUES (1,1,42,'Prior watch',7,'2028-01-02 03:04:05','2028-01-02T03:04:05.000Z','2028-01-02','UTC',1)").run();
    module.db.prepare("INSERT INTO score_events(id,event_key,user_id,watch_id,category,points,rule_version,metadata_json,created_at,effective_at) VALUES (1,'prior/watch/1',1,1,'watch_first',7,'competition-v1','{}','2028-01-02T03:04:05.000Z','2028-01-02T03:04:05.000Z')").run();
    for (const name of ['trg_watches_provider_tuple_insert','trg_watches_provider_tuple_update','trg_watches_provider_tuple_immutable','trg_score_events_reversal_shape_insert','trg_score_events_reversal_marks_parent','trg_score_events_reversed_at_once','trg_score_events_projection_copy_insert','trg_score_events_season_frozen_insert','trg_score_events_season_frozen_update']) module.db.exec('DROP TRIGGER IF EXISTS '+name);
  `);
  assert.equal(build.status, 0, build.stderr);
  let database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.equal(database.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 9);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_score_events_reversal_marks_parent'").get(), undefined);
  database.close();
  const upgrade = runModule(dataDir, "upgrade-v10", `
    module.initializeDatabase();
    module.db.prepare("INSERT INTO score_events(event_key,user_id,watch_id,category,points,rule_version,metadata_json,created_at,effective_at,reverses_event_id) VALUES ('prior/watch/1/reversal',1,1,'watch_first',-7,'competition-v1','{}','2028-02-01T00:00:00.000Z','2028-01-02T03:04:05.000Z',1)").run();
  `);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  database = new Database(path.join(dataDir, "reelscore.db"), { readonly: true });
  assert.equal(database.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 10);
  assert.equal(database.prepare("SELECT reversed_at FROM score_events WHERE id=1").get().reversed_at, "2028-02-01T00:00:00.000Z");
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_score_events_projection_copy_insert'").get());
  database.close();
});

test("schema 9 enforces league, invite, season, participant, and projection ownership", () => {
  const dataDir = tempDir("v9-integrity");
  createExactV8(dataDir, "build-v8-integrity");
  const run = runModule(dataDir, "upgrade-v9-integrity", "module.initializeDatabase();");
  assert.equal(run.status, 0, run.stderr);
  const database = new Database(path.join(dataDir, "reelscore.db"));
  database.pragma("foreign_keys = ON");
  assert.throws(() => database.prepare("INSERT INTO leagues(name,timezone,created_by_user_id) VALUES ('Ownerless','UTC',1)").run(), /not null/i);
  database.prepare("INSERT INTO leagues(id,name,timezone,default_mode,owner_user_id,created_by_user_id) VALUES (1,'League One','UTC','casual',1,1),(2,'League Two','UTC','verified',3,3)").run();
  database.prepare(`INSERT INTO league_memberships(id,league_id,user_id,role,joined_at) VALUES
    (1,1,1,'member','2027-01-01T00:00:00.000Z'), (2,1,2,'member','2027-01-02T00:00:00.000Z'),
    (3,2,3,'member','2027-01-01T00:00:00.000Z')`).run();
  assert.throws(() => database.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at) VALUES (1,2,'member','2027-02-01T00:00:00.000Z')").run(), /active membership|unique|overlap/i);
  assert.throws(() => database.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,left_at) VALUES (1,2,'member','2026-12-01T00:00:00.000Z','2027-01-03T00:00:00.000Z')").run(), /overlap/i);
  assert.throws(() => database.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at) VALUES (1,3,'owner','2027-01-01T00:00:00.000Z')").run(), /check constraint/i);
  assert.throws(() => database.prepare("UPDATE league_memberships SET left_at='2027-02-01T00:00:00.000Z' WHERE id=1").run(), /owner membership/i);
  assert.throws(() => database.prepare("DELETE FROM league_memberships WHERE id=1").run(), /owner membership|membership episodes/i);
  assert.throws(() => database.prepare("INSERT INTO league_invites(league_id,created_by_user_id,token_hash,max_uses,expires_at) VALUES (1,2,'member-digest-1234',1,'2031-01-01T00:00:00.000Z')").run(), /invite creator/i);
  database.prepare("UPDATE league_memberships SET role='admin' WHERE id=2").run();
  database.prepare("INSERT INTO league_invites(id,league_id,created_by_user_id,token_hash,max_uses,expires_at) VALUES (2,1,2,'admin-digest-1234',1,'2031-01-01T00:00:00.000Z')").run();
  assert.throws(() => database.prepare("UPDATE leagues SET owner_user_id=999 WHERE id=1").run(), /owner membership|foreign key/i);
  assert.equal(database.prepare("SELECT owner_user_id FROM leagues WHERE id=1").get().owner_user_id, 1);
  assert.throws(() => database.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,left_at) VALUES (1,3,'member','bad','2027-01-01T00:00:00.000Z')").run(), /check constraint|timestamp invalid/i);
  database.prepare("INSERT INTO league_invites(id,league_id,created_by_user_id,token_hash,max_uses,expires_at) VALUES (1,1,1,'digest-0123456789',1,'2031-01-01T00:00:00.000Z')").run();
  database.prepare("INSERT INTO league_invite_uses(invite_id,user_id,membership_id,used_at) VALUES (1,2,2,'2028-01-01T00:00:00.000Z')").run();
  assert.throws(() => database.prepare("INSERT INTO league_invite_uses(invite_id,user_id,membership_id,used_at) VALUES (1,3,3,'2028-01-02T00:00:00.000Z')").run(), /capacity|ownership/i);
  assert.throws(() => database.prepare("DELETE FROM league_invite_uses WHERE invite_id=1 AND user_id=2").run(), /invite use.*immutable/i);
  assert.throws(() => database.prepare("UPDATE league_invites SET league_id=2 WHERE id=1").run(), /invite identity.*immutable/i);
  assert.throws(() => database.prepare("UPDATE league_invites SET expires_at='2032-01-01T00:00:00.000Z' WHERE id=1").run(), /invite identity.*immutable/i);
  assert.throws(() => database.prepare("UPDATE league_invites SET max_uses=100 WHERE id=1").run(), /invite identity.*immutable/i);
  database.prepare("UPDATE league_invites SET revoked_at='2028-01-03T00:00:00.000Z' WHERE id=1").run();
  assert.throws(() => database.prepare("UPDATE league_invites SET revoked_at=NULL WHERE id=1").run(), /revocation.*immutable/i);
  database.prepare("UPDATE league_invites SET revoked_at='2028-01-03T00:00:00.000Z' WHERE id=2").run();
  assert.throws(() => database.prepare("INSERT INTO league_invite_uses(invite_id,user_id,membership_id,used_at) VALUES (2,2,2,'2028-01-04T00:00:00.000Z')").run(), /capacity or ownership mismatch/i);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM league_invite_uses WHERE invite_id=1").get().count, 1);
  assert.throws(() => database.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (2,'Impossible','verified','UTC','season-v1','2031-02-29T00:00:00.000Z','2031-03-02T00:00:00.000Z',3)`).run(), /seasons timestamp invalid/i);
  database.prepare(`INSERT INTO seasons(id,league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (1,1,'Season One','casual','UTC','season-v1','2028-01-01T00:00:00.000Z','2028-02-01T00:00:00.000Z',2)`).run();
  assert.throws(() => database.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,finalized_at,participants_locked_at,created_by_user_id)
    VALUES (2,'Pre-finalized','verified','UTC','season-v1','2033-01-01T00:00:00.000Z','2033-02-01T00:00:00.000Z','2033-02-04T00:00:00.000Z','2033-01-01T00:00:00.000Z',3)`).run(), /lifecycle transitions.*pre-applied/i);
  assert.throws(() => database.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,cancelled_at,created_by_user_id)
    VALUES (2,'Pre-cancelled','verified','UTC','season-v1','2033-01-01T00:00:00.000Z','2033-02-01T00:00:00.000Z','2032-12-01T00:00:00.000Z',3)`).run(), /lifecycle transitions.*pre-applied/i);
  assert.throws(() => database.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (1,'Overlap','casual','UTC','season-v1','2028-01-15T00:00:00.000Z','2028-03-01T00:00:00.000Z',1)`).run(), /overlap/i);
  assert.throws(() => database.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (1,'Bad bounds','casual','UTC','season-v1','2028-03-01T00:00:00.000Z','2028-02-01T00:00:00.000Z',1)`).run(), /check constraint/i);
  database.prepare("INSERT INTO season_members(id,season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (1,1,2,2,'user-two','2028-01-01T00:00:00.000Z')").run();
  assert.throws(() => database.prepare("INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (1,3,3,'user-three','2028-01-01T00:00:00.000Z')").run(), /participant ownership/i);
  assert.throws(() => database.prepare("UPDATE season_members SET eligible_until='2028-03-01T00:00:00.000Z' WHERE id=1").run(), /cutoff|check constraint/i);
  database.prepare("UPDATE watches SET qualifies_for_season=1 WHERE id=1").run();
  database.prepare("UPDATE seasons SET participants_locked_at='2028-01-01T00:00:00.000Z' WHERE id=1").run();
  database.prepare(`INSERT INTO score_events(event_key,user_id,watch_id,season_id,projection_source_event_id,season_member_id,category,points,rule_version,created_at,effective_at)
    VALUES ('season/1/watch-event/1',2,1,1,1,1,'watch_first',17,'competition-v1','2028-01-02T03:04:05.000Z','2028-01-02T03:04:05.000Z')`).run();
  assert.throws(() => database.prepare(`INSERT INTO score_events(event_key,user_id,watch_id,season_id,projection_source_event_id,season_member_id,category,points,rule_version,effective_at)
    VALUES ('season/1/watch-event/1',2,1,1,1,1,'watch_first',17,'competition-v1','2028-01-02T03:04:05.000Z')`).run(), /unique/i);
  const reissuedSourceId = Number(database.prepare(`INSERT INTO score_events
    (event_key,user_id,watch_id,category,points,rule_version,effective_at)
    VALUES ('v8/watch/1/reissued',2,1,'watch_rewatch',4,'competition-v1','2028-01-02T03:04:05.000Z')`).run().lastInsertRowid);
  database.prepare(`INSERT INTO score_events
    (event_key,user_id,watch_id,season_id,projection_source_event_id,season_member_id,category,points,rule_version,effective_at)
    VALUES (?,?,?,?,?,?,?,?,?,'2028-01-02T03:04:05.000Z')`)
    .run(`season/1/watch-event/${reissuedSourceId}`,2,1,1,reissuedSourceId,1,'watch_rewatch',4,'competition-v1');
  assert.equal(database.prepare("SELECT COUNT(*) count FROM score_events WHERE season_id=1 AND reverses_event_id IS NULL").get().count, 2);
  assert.throws(() => database.prepare(`INSERT INTO score_events(event_key,user_id,watch_id,season_id,projection_source_event_id,season_member_id,category,points,rule_version)
    VALUES ('season/cross-user',1,1,1,1,1,'watch_first',17,'season-v1')`).run(), /source|participant|owner mismatch/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events(event_key,user_id,category,points,rule_version,season_id)
    VALUES ('season/cross-league',3,'challenge_bonus',5,'season-v1',1)`).run(), /participant|season row/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events(event_key,user_id,category,points,rule_version,season_id)
    VALUES ('season/orphan',2,'challenge_bonus',5,'season-v1',999)`).run(), /season/i);
  assert.throws(() => database.prepare("UPDATE league_memberships SET joined_at='2029-01-01T00:00:00.000Z' WHERE id=2").run(), /membership episode.*immutable/i);
  assert.throws(() => database.prepare("UPDATE season_members SET username_snapshot='rewritten' WHERE id=1").run(), /participant snapshot.*immutable/i);
  assert.throws(() => database.prepare("DELETE FROM season_members WHERE id=1").run(), /participant set.*locked/i);
  assert.throws(() => database.prepare("INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (1,1,1,'late','2028-01-01T00:00:00.000Z')").run(), /participant set.*locked/i);
  assert.throws(() => database.prepare("UPDATE score_events SET watch_id=NULL WHERE id=1").run(), /source|participant mismatch/i);
  assert.throws(() => database.prepare("UPDATE score_events SET category='challenge_bonus',projection_source_event_id=NULL WHERE event_key='season/1/watch-event/1'").run(), /ledger identity.*immutable/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events
    (event_key,user_id,watch_id,season_id,season_member_id,category,points,rule_version,effective_at)
    VALUES ('season/1/watch/no-source',2,1,1,1,'watch_first',1,'season-v1','2028-01-03T00:00:00.000Z')`).run(), /projection source/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events
    (event_key,user_id,season_id,season_member_id,category,points,rule_version,effective_at)
    VALUES ('season/1/bad-time',2,1,1,'challenge_bonus',1,'season-v1','2028-02-30T00:00:00.000Z')`).run(), /effective time.*invalid/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events
    (event_key,user_id,category,points,rule_version,created_at,effective_at)
    VALUES ('lifetime/bad-created',2,'challenge_bonus',1,'season-v1','2028-02-30 00:00:00','2028-02-28T00:00:00.000Z')`).run(), /created or effective time invalid/i);
  assert.throws(() => database.prepare("UPDATE seasons SET mode='verified' WHERE id=1").run(), /started season settings/i);
  database.prepare("UPDATE season_members SET eligible_until='2028-01-15T00:00:00.000Z' WHERE id=1").run();
  database.prepare("UPDATE league_memberships SET left_at='2028-01-15T00:00:00.000Z' WHERE id=2").run();
  assert.throws(() => database.prepare("UPDATE league_memberships SET left_at='2028-01-16T00:00:00.000Z' WHERE id=2").run(), /closure.*immutable/i);
  assert.throws(() => database.prepare("UPDATE season_members SET eligible_until='2028-01-16T00:00:00.000Z' WHERE id=1").run(), /cutoff.*immutable|ownership or cutoff mismatch/i);
  database.prepare("UPDATE seasons SET finalized_at='2028-02-04T00:00:00.000Z' WHERE id=1").run();
  assert.throws(() => database.prepare("UPDATE seasons SET finalized_at=NULL WHERE id=1").run(), /finalized season.*immutable|finalization.*irreversible/i);
  assert.throws(() => database.prepare("UPDATE seasons SET finalized_at='2028-02-05T00:00:00.000Z' WHERE id=1").run(), /finalized season.*immutable|finalization.*irreversible/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events
    (event_key,user_id,season_id,season_member_id,category,points,rule_version,effective_at)
    VALUES ('season/1/post-final',2,1,1,'challenge_bonus',1,'season-v1','2028-01-20T00:00:00.000Z')`).run(), /season standings.*immutable/i);
  assert.throws(() => database.prepare("UPDATE score_events SET reversed_at='2028-02-05T00:00:00.000Z' WHERE event_key='season/1/watch-event/1'").run(), /season standings.*immutable/i);
  assert.throws(() => database.prepare("UPDATE season_members SET eligible_until='2028-01-20T00:00:00.000Z' WHERE id=1").run(), /finalized.*season participants.*immutable/i);
  database.prepare(`INSERT INTO seasons(id,league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (2,2,'Cancelled','verified','UTC','season-v1','2032-01-01T00:00:00.000Z','2032-02-01T00:00:00.000Z',3)`).run();
  database.prepare("INSERT INTO season_members(id,season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (2,2,3,3,'user-three','2032-01-01T00:00:00.000Z')").run();
  database.prepare("UPDATE seasons SET participants_locked_at='2032-01-01T00:00:00.000Z' WHERE id=2").run();
  database.prepare("UPDATE seasons SET cancelled_at='2031-12-01T00:00:00.000Z' WHERE id=2").run();
  assert.throws(() => database.prepare("UPDATE seasons SET cancelled_at=NULL WHERE id=2").run(), /cancelled season.*immutable|cancellation.*irreversible/i);
  assert.throws(() => database.prepare("UPDATE season_members SET username_snapshot='cancelled-rewrite' WHERE id=2").run(), /cancelled season participants.*immutable/i);
  assert.throws(() => database.prepare("DELETE FROM season_members WHERE id=2").run(), /participant set.*frozen/i);
  assert.throws(() => database.prepare("INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (2,3,3,'duplicate-after-cancel','2032-01-01T00:00:00.000Z')").run(), /participant set.*frozen/i);
  assert.throws(() => database.prepare("DELETE FROM seasons WHERE id=2").run(), /season records.*immutable/i);
  assert.throws(() => database.prepare("DELETE FROM league_invites WHERE id=2").run(), /invites are revoked/i);
  assert.throws(() => database.prepare("DELETE FROM leagues WHERE id=2").run(), /leagues are archived/i);
  assert.throws(() => database.prepare(`INSERT INTO score_events
    (event_key,user_id,season_id,season_member_id,category,points,rule_version,effective_at)
    VALUES ('season/2/cancelled',3,2,2,'challenge_bonus',1,'season-v1','2032-01-02T00:00:00.000Z')`).run(), /season standings.*immutable/i);
  database.close();
});
