process.env.DATA_DIR = `/tmp/rs-migration-v14-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";

const database = await import("../src/db.js");
database.initializeDatabase({ targetVersion: 13 });
const { db, runMigrations } = database;
const { insertWatch } = await import("../src/repositories/watch-repository.js");

const movie = (id) => ({ id, title: `Migration ${id}`, vote_average: 7.2, runtime: 111, genres: [{ id: 18, name: "Drama" }], credits: { cast: [], crew: [] } });

test("schema 13 to 14 is additive, backed up, integral, and idempotent", () => {
  const userId = Number(db.prepare("INSERT INTO users(username,password_hash,timezone) VALUES ('migration14','x','UTC')").run().lastInsertRowid);
  const manual = insertWatch({ userId, movie: movie(1401), watchedAt: "2035-01-10T12:00:00.000Z" });
  const provider = insertWatch({ userId, movie: movie(1402), watchedAt: "2035-01-11T12:00:00.000Z", source: "plex",
    providerService: "plex", providerConnectionId: "connection", providerEventId: "event-1402" });
  const oldColumns = db.prepare("PRAGMA table_info(watches)").all().map((column) => column.name);
  const selectOld = `SELECT ${oldColumns.map((name) => `"${name}"`).join(",")} FROM watches WHERE id=?`;
  const before = [manual.id, provider.id].map((id) => db.prepare(selectOld).get(id));

  const migrated = runMigrations();
  assert.equal(migrated.backup.ok, true);
  assert.equal(fs.existsSync(migrated.backup.path), true);
  const backup = new Database(migrated.backup.path, { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare("SELECT MAX(version) version FROM schema_versions").get().version, 13);
  assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
  backup.close();

  const after = [manual.id, provider.id].map((id) => db.prepare(selectOld).get(id));
  assert.deepEqual(after, before);
  for (const id of [manual.id, provider.id]) assert.deepEqual(
    db.prepare("SELECT personal_rating,review,private_notes,favorite,tags_json,venue,visibility FROM watches WHERE id=?").get(id),
    { personal_rating: null, review: null, private_notes: null, favorite: 0, tags_json: "[]", venue: null, visibility: "private" },
  );
  const cancelledCase = Number(db.prepare(`INSERT INTO duplicate_cases
    (user_id,fingerprint,canonical_watch_id,candidate_watch_id,status,resolution,evidence_json,resolved_at,cancelled_at,cancellation_reason)
    VALUES (?,?,?,?,'resolved','keep_both','{}','2035-01-12T00:00:00.000Z','2035-01-13T00:00:00.000Z','date_changed')`)
    .run(userId,"duplicate-v1:1402:2035-01-11",manual.id,provider.id).lastInsertRowid);
  const activeCase = Number(db.prepare(`INSERT INTO duplicate_cases
    (user_id,fingerprint,canonical_watch_id,candidate_watch_id,evidence_json) VALUES (?,?,?,?,'{}')`)
    .run(userId,"duplicate-v1:1402:2035-01-12",manual.id,provider.id).lastInsertRowid);
  assert.notEqual(activeCase,cancelledCase);
  assert.throws(()=>db.prepare(`INSERT INTO duplicate_cases
    (user_id,fingerprint,canonical_watch_id,candidate_watch_id,evidence_json) VALUES (?,?,?,?,'{}')`)
    .run(userId,"duplicate-v1:1402:2035-01-13",manual.id,provider.id),/UNIQUE/i);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_versions WHERE version=14").get().count, 1);
  assert.equal(runMigrations().backup, null);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_versions WHERE version=14").get().count, 1);
});
