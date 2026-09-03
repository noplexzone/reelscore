process.env.DATA_DIR = `/tmp/rs-migration-v15-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const database = await import("../src/db.js");
database.initializeDatabase({ targetVersion: 14 });
const { db, runMigrations } = database;
const { insertWatch } = await import("../src/repositories/watch-repository.js");

const movie = (id) => ({ id, title: `Migration ${id}`, vote_average: 7.2, runtime: 111,
  release_date: "2034-02-03", genres: [{ id: 18, name: "Drama" }],
  belongs_to_collection: { id: 91, name: "Migration Collection" } });

function insertRawImport(userId, suffix, overrides = {}) {
  const row = {
    user_id: userId, tmdb_id: 1500 + suffix, title: `Imported ${suffix}`, points: 0, source: "letterboxd",
    watched_at: "2035-01-10 12:00:00", watched_at_utc: "2035-01-10T12:00:00.000Z",
    watched_day_local: "2035-01-10", timezone_used: "UTC", qualifies_for_volume: 0,
    qualifies_for_achievement: 0, qualifies_for_streak: 0, qualifies_for_season: 0, visibility: "private",
    competition_eligibility: "unverified_import", source_recorded_date: "2035-01-10", source_date_kind: "watched_day",
    import_source: "letterboxd", import_event_key: `diary:https://letterboxd.com/film/${suffix}/:2035-01-10:1`,
    provider_service: null, provider_connection_id: null, provider_event_id: null, ...overrides,
  };
  return db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,points,source,watched_at,watched_at_utc,watched_day_local,timezone_used,
     qualifies_for_volume,qualifies_for_achievement,qualifies_for_streak,qualifies_for_season,visibility,
     competition_eligibility,source_recorded_date,source_date_kind,import_source,import_event_key,
     provider_service,provider_connection_id,provider_event_id)
    VALUES (@user_id,@tmdb_id,@title,@points,@source,@watched_at,@watched_at_utc,@watched_day_local,@timezone_used,
      @qualifies_for_volume,@qualifies_for_achievement,@qualifies_for_streak,@qualifies_for_season,@visibility,
      @competition_eligibility,@source_recorded_date,@source_date_kind,@import_source,@import_event_key,
      @provider_service,@provider_connection_id,@provider_event_id)`).run(row);
}

test("schema 14 to 15 preserves legacy watches and adds safe eligible defaults", () => {
  const userId = Number(db.prepare("INSERT INTO users(username,password_hash,timezone) VALUES ('migration15','x','UTC')").run().lastInsertRowid);
  const manual = insertWatch({ userId, movie: movie(1401), watchedAt: "2035-01-10T12:00:00.000Z" });
  const provider = insertWatch({ userId, movie: movie(1402), watchedAt: "2035-01-11T12:00:00.000Z", source: "plex",
    providerService: "plex", providerConnectionId: "connection", providerEventId: "event-1402" });
  db.prepare(`UPDATE watches SET personal_rating=85,review='preserve',private_notes='bytes',favorite=1,
    tags_json='["drama"]',venue='Home',visibility='friends' WHERE id=?`).run(manual.id);
  const oldColumns = db.prepare("PRAGMA table_info(watches)").all().map((column) => column.name);
  const selectOld = `SELECT ${oldColumns.map((name) => `"${name}"`).join(",")} FROM watches WHERE id=?`;
  const before = [manual.id, provider.id].map((id) => db.prepare(selectOld).get(id));

  const migrated = runMigrations();
  assert.equal(migrated.backup.ok, true);
  const backup = new Database(migrated.backup.path, { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 14);
  assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual([manual.id, provider.id].map((id) => backup.prepare(selectOld).get(id)), before);
  backup.close();

  assert.deepEqual([manual.id, provider.id].map((id) => db.prepare(selectOld).get(id)), before);
  for (const id of [manual.id, provider.id]) assert.deepEqual(
    db.prepare(`SELECT competition_eligibility,source_recorded_date,source_date_kind,import_source,import_event_key FROM watches WHERE id=?`).get(id),
    { competition_eligibility: "eligible", source_recorded_date: null, source_date_kind: null, import_source: null, import_event_key: null },
  );
  for (const table of ["letterboxd_import_jobs", "letterboxd_import_rows"]) assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  const jobsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='letterboxd_import_jobs'").get().sql;
  assert.match(jobsSql, /file_digest TEXT NOT NULL/i);
  assert.match(jobsSql, /UNIQUE\s*\(user_id\s*,\s*file_digest\)/i);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_watches_import_identity'").get();
  assert.match(index.sql, /user_id\s*,\s*import_source\s*,\s*import_event_key/i);
  assert.match(index.sql, /WHERE\s+import_source\s+IS\s+NOT\s+NULL\s+AND\s+import_event_key\s+IS\s+NOT\s+NULL/i);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_versions WHERE version=15").get().count, 1);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  const backupsBefore = fs.readdirSync(path.join(process.env.DATA_DIR, "backups")).length;
  assert.equal(runMigrations().backup, null);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_versions WHERE version=15").get().count, 1);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, "backups")).length, backupsBefore);
  const insertJob = db.prepare(`INSERT INTO letterboxd_import_jobs
    (user_id,public_job_id,file_digest,diary_file_sha256,commit_token_hash,row_count,expires_at)
    VALUES (?,?,?,?,?,?,?)`);
  const digest = "a".repeat(64);
  insertJob.run(userId, "public-job-id-0001", digest, "b".repeat(64), "c".repeat(64), 1, "2036-01-01T00:00:00.000Z");
  assert.throws(() => insertJob.run(userId, "public-job-id-0002", digest, "d".repeat(64), "e".repeat(64), 1,
    "2036-01-01T00:00:00.000Z"), /UNIQUE/i);
});

test("database firewall rejects malformed or competitive unverified imports", () => {
  const userId = db.prepare("SELECT id FROM users WHERE username='migration15'").get().id;
  const invalidRows = [
    { source: "manual" }, { source: "plex" }, { source: "LETTERBOXD" },
    { points: 1 }, { qualifies_for_volume: 1 }, { qualifies_for_achievement: 1 }, { qualifies_for_streak: 1 },
    { qualifies_for_season: 1 }, { visibility: "friends" }, { provider_service: "plex" },
    { provider_connection_id: "connection" }, { provider_event_id: "event" }, { import_source: null },
    { import_source: " " }, { import_event_key: null }, { import_event_key: " " }, { source_recorded_date: null },
    { source_recorded_date: "2035-02-30" }, { source_date_kind: null }, { source_date_kind: "provider" },
  ];
  invalidRows.forEach((overrides, index) => {
    assert.throws(() => insertRawImport(userId, index + 1, overrides), /unverified import/i, JSON.stringify(overrides));
  });

  const importedId = Number(insertRawImport(userId, 100).lastInsertRowid);
  assert.throws(() => db.prepare(`UPDATE watches SET competition_eligibility='eligible',import_source=NULL,
    import_event_key=NULL,source_recorded_date=NULL,source_date_kind=NULL WHERE id=?`).run(importedId), /unverified import/i);
  for (const sql of ["UPDATE watches SET points=1 WHERE id=?", "UPDATE watches SET qualifies_for_streak=1 WHERE id=?",
    "UPDATE watches SET visibility='public' WHERE id=?", "UPDATE watches SET provider_event_id='forged' WHERE id=?",
    "UPDATE watches SET source='manual' WHERE id=?", "UPDATE watches SET source_recorded_date='2035-01-11' WHERE id=?",
    "UPDATE watches SET source_date_kind='marked_watched_day' WHERE id=?",
    "UPDATE watches SET import_event_key='diary:https://letterboxd.com/film/100/:2035-01-10:2' WHERE id=?"])
    assert.throws(() => db.prepare(sql).run(importedId), /unverified import/i);
  assert.throws(() => insertRawImport(userId, 101, { tmdb_id: 9999,
    import_event_key: "diary:https://letterboxd.com/film/100/:2035-01-10:1" }), /UNIQUE/i);
  assert.throws(() => db.prepare(`INSERT INTO watches(user_id,tmdb_id,title,points,source,watched_at)
    VALUES (?,9997,'Forged eligible Letterboxd',0,'letterboxd','2035-01-12 12:00:00')`).run(userId), /unverified import/i);
  const ordinaryId = Number(db.prepare(`INSERT INTO watches(user_id,tmdb_id,title,points,watched_at)
    VALUES (?,9998,'Ordinary legacy-compatible insert',0,'2035-01-12 12:00:00')`).run(userId).lastInsertRowid);
  assert.equal(db.prepare("SELECT competition_eligibility FROM watches WHERE id=?").get(ordinaryId).competition_eligibility, "eligible");
});

test("watch repository validates and persists unverified import provenance", () => {
  const userId = db.prepare("SELECT id FROM users WHERE username='migration15'").get().id;
  assert.throws(() => insertWatch({ userId, movie: movie(1549), source: "letterboxd",
    watchedAt: "2035-01-19T12:00:00.000Z" }), /must be unverified/i);
  const base = { userId, movie: movie(1550), source: "letterboxd", watchedAt: "2035-01-20T12:00:00.000Z",
    competitionEligibility: "unverified_import", sourceRecordedDate: "2035-01-20", sourceDateKind: "watched_day",
    importSource: "letterboxd", importEventKey: "diary:https://letterboxd.com/film/repository/:2035-01-20:1" };
  assert.throws(() => insertWatch({ ...base, providerService: "plex" }), /unverified import/i);
  assert.throws(() => insertWatch({ ...base, sourceRecordedDate: "2035-02-30" }), /sourceRecordedDate/i);
  assert.throws(() => insertWatch({ ...base, importEventKey: " " }), /importEventKey/i);
  const watch = insertWatch(base);
  assert.deepEqual(db.prepare(`SELECT points,visibility,competition_eligibility,source_recorded_date,source_date_kind,
    import_source,import_event_key,provider_service,provider_connection_id,provider_event_id,
    qualifies_for_volume,qualifies_for_achievement,qualifies_for_streak,qualifies_for_season FROM watches WHERE id=?`).get(watch.id), {
    points: 0, visibility: "private", competition_eligibility: "unverified_import", source_recorded_date: "2035-01-20",
    source_date_kind: "watched_day", import_source: "letterboxd",
    import_event_key: "diary:https://letterboxd.com/film/repository/:2035-01-20:1",
    provider_service: null, provider_connection_id: null, provider_event_id: null,
    qualifies_for_volume: 0, qualifies_for_achievement: 0, qualifies_for_streak: 0, qualifies_for_season: 0,
  });
});

test("migration 15 rolls back additive DDL and can retry after a forced version-marker failure", () => {
  const dataDir = `/tmp/rs-migration-v15-rollback-${process.pid}`;
  fs.rmSync(dataDir, { recursive: true, force: true });
  const moduleUrl = pathToFileURL(path.resolve("src/db.js")).href;
  const source = `process.env.DATA_DIR=${JSON.stringify(dataDir)}; process.env.SESSION_SECRET='test-secret-that-is-at-least-32-chars-long';
    process.env.NODE_ENV='test'; process.env.APP_MODE='self_hosted'; const module=await import(${JSON.stringify(moduleUrl)});
    module.initializeDatabase({targetVersion:14}); module.db.exec("CREATE TEMP TRIGGER force_v15_failure BEFORE INSERT ON schema_versions WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'forced v15 failure'); END;");
    let message=''; try { module.runMigrations({targetVersion:15,skipBackup:true}); } catch(error) { message=error.message; }
    const failed={message,version:Boolean(module.db.prepare('SELECT 1 FROM schema_versions WHERE version=15').get()),
      column:new Set(module.db.prepare('PRAGMA table_info(watches)').all().map(row=>row.name)).has('competition_eligibility'),
      table:Boolean(module.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='letterboxd_import_jobs'").get())};
    module.db.exec('DROP TRIGGER force_v15_failure'); module.runMigrations({targetVersion:15,skipBackup:true});
    console.log(JSON.stringify({failed,version:module.db.prepare('SELECT MAX(version) version FROM schema_versions').get().version,
      integrity:module.db.pragma('integrity_check',{simple:true}),foreignKeys:module.db.pragma('foreign_key_check')}));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.match(result.failed.message, /forced v15 failure/i);
  assert.deepEqual(result.failed, { message: result.failed.message, version: false, column: false, table: false });
  assert.equal(result.version, 15);
  assert.equal(result.integrity, "ok");
  assert.deepEqual(result.foreignKeys, []);
});


test("import row links cannot cross owners or disagree with the selected movie", () => {
  const ownerId = db.prepare("SELECT id FROM users WHERE username='migration15'").get().id;
  const otherId = Number(db.prepare("INSERT INTO users(username,password_hash,timezone) VALUES ('migration15_other','x','UTC')").run().lastInsertRowid);
  const ownerWatch = insertWatch({ userId: ownerId, movie: movie(1601), watchedAt: "2035-02-01T12:00:00.000Z" });
  const otherWatch = insertWatch({ userId: otherId, movie: movie(1602), watchedAt: "2035-02-01T12:00:00.000Z" });
  const jobId = Number(db.prepare(`INSERT INTO letterboxd_import_jobs
    (user_id,public_job_id,file_digest,diary_file_sha256,commit_token_hash,row_count,expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(ownerId, "public-job-links-01", "1".repeat(64), "2".repeat(64), "3".repeat(64), 3,
      "2036-01-01T00:00:00.000Z").lastInsertRowid);
  const insertRow = db.prepare(`INSERT INTO letterboxd_import_rows
    (job_id,source_row_number,file_kind,row_snapshot_json,source_recorded_date,source_date_kind,
     import_event_key,resolution_state,selected_tmdb_id,watch_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const args = (row, key, tmdbId, watchId) => [jobId, row, "diary", "{}", "2035-02-01", "watched_day",
    key, "imported", tmdbId, watchId];
  assert.throws(() => insertRow.run(...args(2, "diary:cross-owner", otherWatch.tmdb_id, otherWatch.id)), /owner|movie/i);
  assert.throws(() => insertRow.run(...args(3, "diary:wrong-movie", ownerWatch.tmdb_id + 1, ownerWatch.id)), /owner|movie/i);
  insertRow.run(...args(4, "diary:valid-link", ownerWatch.tmdb_id, ownerWatch.id));
  const immutableJobUpdates = [
    ["UPDATE letterboxd_import_jobs SET user_id=? WHERE id=?", otherId],
    ["UPDATE letterboxd_import_jobs SET public_job_id=? WHERE id=?", "public-job-links-02"],
    ["UPDATE letterboxd_import_jobs SET file_digest=? WHERE id=?", "4".repeat(64)],
    ["UPDATE letterboxd_import_jobs SET diary_file_sha256=? WHERE id=?", "5".repeat(64)],
    ["UPDATE letterboxd_import_jobs SET row_count=? WHERE id=?", 4],
  ];
  for (const [sql, value] of immutableJobUpdates) {
    assert.throws(() => db.prepare(sql).run(value, jobId), /import job identity is immutable/i);
  }
  db.prepare("UPDATE letterboxd_import_jobs SET commit_token_hash=? WHERE id=? AND state='preview'").run("6".repeat(64), jobId);
  db.prepare("UPDATE letterboxd_import_jobs SET state='committing' WHERE id=?").run(jobId);
  assert.throws(() => db.prepare("UPDATE letterboxd_import_jobs SET commit_token_hash=? WHERE id=?").run("7".repeat(64), jobId), /import job identity is immutable/i);
  assert.throws(() => db.prepare("UPDATE letterboxd_import_rows SET watch_id=? WHERE import_event_key='diary:valid-link'")
    .run(otherWatch.id), /owner|movie/i);
  assert.throws(() => db.prepare("UPDATE letterboxd_import_rows SET selected_tmdb_id=? WHERE import_event_key='diary:valid-link'")
    .run(ownerWatch.tmdb_id + 1), /owner|movie/i);
});
