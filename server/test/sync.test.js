process.env.DATA_DIR = `/tmp/rs-sync-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
const { db } = await import("../src/db.js");
const {
  applyPlaceholderReconciliation,
  importHistory,
  normalizePlexUrl,
  previewPlaceholderReconciliation,
} = await import("../src/sync.js");

const fakeMovie = (id, over = {}) => ({
  id, title: `Film ${id}`, poster_path: null, vote_average: 7.0, runtime: 120,
  release_date: "2000-01-01", genres: [{ name: "Drama" }], belongs_to_collection: null,
  credits: { cast: [], crew: [] }, ...over,
});
const getMovie = async (id) => fakeMovie(id);
const event = (tmdb_id, watched_at, event_id) => ({ tmdb_id, watched_at, event_id });
function makeUser(prefix) {
  return Number(db.prepare("INSERT INTO users (username,password_hash) VALUES (?, 'x')").run(`${prefix}_${Date.now()}_${Math.random()}`).lastInsertRowid);
}
const watchesOf = (uid) => db.prepare("SELECT * FROM watches WHERE user_id=? ORDER BY watched_at,id").all(uid);


test("historical scoring uses each event timestamp, cooldown, and only earlier watches", async () => {
  const uid = makeUser("historical");
  await importHistory(uid, "trakt", [
    event(101, "2020-01-01T20:00:00Z", "h1"),
    event(101, "2020-01-02T20:00:00Z", "h2"),
    event(101, "2020-03-15T20:00:00Z", "h3"),
  ], getMovie, { connectionId: "trakt-account-1" });
  const rows = watchesOf(uid);
  assert.deepEqual(rows.map((row) => [row.points, row.is_rewatch]), [[49, 0], [0, 1], [12, 1]]);

  const futureUser = makeUser("future");
  await importHistory(futureUser, "trakt", [event(102, "2030-01-01T00:00:00Z", "future")], getMovie, { connectionId: "acct" });
  await importHistory(futureUser, "trakt", [event(102, "2020-01-01T00:00:00Z", "past")], getMovie, { connectionId: "acct" });
  const [past, future] = watchesOf(futureUser);
  assert.deepEqual([past.points, past.is_rewatch], [49, 0]);
  assert.deepEqual([future.points, future.is_rewatch], [12, 1]);
});


test("provider event identity preserves same-film same-day plays and avoids provider/connection collisions", async () => {
  const uid = makeUser("events");
  const sameDay = [event(201, "2022-03-03T10:00:00Z", "1"), event(201, "2022-03-03T22:00:00Z", "2")];
  const result = await importHistory(uid, "plex", sameDay, getMovie, { connectionId: "machine:plex-account" });
  assert.equal(result.imported, 2);
  await importHistory(uid, "trakt", [event(201, "2022-03-03T22:00:00Z", "1")], getMovie, { connectionId: "trakt-account" });
  await importHistory(uid, "plex", [event(201, "2022-03-04T22:00:00Z", "1")], getMovie, { connectionId: "other-machine:plex-account" });
  const rows = watchesOf(uid);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.provider_event_id)).size, 4);
  assert.ok(rows.some((row) => row.provider_event_id === "plex:machine:plex-account:1"));
  assert.ok(rows.some((row) => row.provider_event_id === "trakt:trakt-account:1"));
});


test("idempotent provider retries retain recognized movie IDs for achievement enrichment", async () => {
  const uid = makeUser("retry_enrichment");
  const items = [event(777, "2022-03-03T22:00:00Z", "retry-event")];
  const first = await importHistory(uid, "plex", items, getMovie, { connectionId: "retry-account" });
  const retry = await importHistory(uid, "plex", items, getMovie, { connectionId: "retry-account" });
  assert.equal(first.imported, 1);
  assert.equal(retry.skipped, 1);
  assert.deepEqual(retry.movies, [777]);
});

test("parallel and repeated imports are conflict-safe and produce one watch per event", async () => {
  const uid = makeUser("parallel");
  const payload = [event(301, "2020-05-05T18:00:00Z", "stable-history-id")];
  const runs = await Promise.all(Array.from({ length: 8 }, () => importHistory(uid, "trakt", payload, getMovie, { connectionId: "subject-301" })));
  assert.equal(watchesOf(uid).length, 1);
  assert.equal(runs.reduce((sum, run) => sum + run.imported, 0), 1);
  const repeated = await importHistory(uid, "trakt", payload, getMovie, { connectionId: "subject-301" });
  assert.equal(repeated.skipped, 1);
});


test("normal sync is additive and never implicitly converts a same-day manual row", async () => {
  const uid = makeUser("manual");
  const manualId = Number(db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at)
    VALUES (?,401,'Film 401',49,'manual','2022-03-03 10:00:00')`).run(uid).lastInsertRowid);
  const before = db.prepare("SELECT * FROM watches WHERE id=?").get(manualId);
  const unrelatedId = Number(db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,vote_average,runtime,points,is_rewatch,source,watched_at)
    VALUES (?,499,'The Odyssey',8.2,180,123,0,'manual','2022-03-03 11:00:00')`).run(uid).lastInsertRowid);
  const unrelatedBefore = db.prepare("SELECT * FROM watches WHERE id=?").get(unrelatedId);
  await importHistory(uid, "plex", [event(401, "2022-03-03T22:00:00Z", "plex-play")], getMovie, { connectionId: "machine:account" });
  const after = db.prepare("SELECT * FROM watches WHERE id=?").get(manualId);
  for (const field of ["id", "user_id", "tmdb_id", "title", "poster_path", "vote_average", "runtime", "release_date", "genres", "collection_id", "collection_name", "source", "watched_at", "provider_service", "provider_connection_id", "provider_event_id", "deleted_at"]) {
    assert.deepEqual(after[field], before[field], `normal sync must preserve manual ${field}`);
  }
  assert.equal(after.eligibility_reason, "canonical_first_watch");
  assert.deepEqual(db.prepare("SELECT * FROM watches WHERE id=?").get(unrelatedId), unrelatedBefore);
  assert.equal(watchesOf(uid).length, 3);
});


test("legacy provider rows gain unambiguous provenance without changing content", async () => {
  const uid = makeUser("legacy_provider");
  const id = Number(db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,vote_average,runtime,points,is_rewatch,source,watched_at)
    VALUES (?,450,'Legacy',8.5,140,77,1,'plex','2020-01-02 03:04:05')`).run(uid).lastInsertRowid);
  const before = db.prepare("SELECT * FROM watches WHERE id=?").get(id);
  const result = await importHistory(uid, "plex", [event(450, "2020-01-02T03:04:05Z", "immutable")], getMovie, { connectionId: "server:subject" });
  assert.equal(result.verified, 1);
  assert.equal(result.imported, 0);
  const after = db.prepare("SELECT * FROM watches WHERE id=?").get(id);
  assert.deepEqual(
    { ...after, provider_service: before.provider_service, provider_connection_id: before.provider_connection_id, provider_event_id: before.provider_event_id },
    before,
  );
  assert.equal(after.provider_event_id, "plex:server:subject:immutable");
  const repeat = await importHistory(uid, "plex", [event(450, "2020-01-02T03:04:05Z", "immutable")], getMovie, { connectionId: "server:subject" });
  assert.equal(repeat.skipped, 1);
  assert.equal(watchesOf(uid).length, 1);
});

test("ambiguous legacy provider rows fail instead of duplicating history", async () => {
  const uid = makeUser("ambiguous_legacy");
  for (let i = 0; i < 2; i++) db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,points,source,watched_at) VALUES (?,451,'Legacy',49,'trakt','2020-01-01 00:00:00')`).run(uid);
  const result = await importHistory(uid, "trakt", [event(451, "2020-01-01T00:00:00Z", "history")], getMovie, { connectionId: "subject" });
  assert.equal(result.failed, 1);
  assert.equal(result.imported, 0);
  assert.equal(watchesOf(uid).length, 2);
});

test("equal-timestamp provider events use stable order and score the second as a cooldown rewatch", async () => {
  const uid = makeUser("equal_time");
  await importHistory(uid, "plex", [
    event(452, "2020-01-01T00:00:00Z", "a"),
    event(452, "2020-01-01T00:00:00Z", "b"),
  ], getMovie, { connectionId: "server:subject" });
  assert.deepEqual(watchesOf(uid).map((row) => [row.points, row.is_rewatch]), [[49, 0], [0, 1]]);
});


test("explicit preview/apply reconciles selected placeholder in place, preserves unmatched manual data and achievements, and rejects replay", async () => {
  const uid = makeUser("reconcile");
  const placeholderDate = "2026-07-27";
  const selectedId = Number(db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at)
    VALUES (?,501,'Film 501',49,'manual',?)`).run(uid, `${placeholderDate} 08:00:00`).lastInsertRowid);
  const unselectedSameMovieId = Number(db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,points,is_rewatch,source,watched_at)
    VALUES (?,501,'Film 501 second manual',88,1,'manual','2025-01-01 08:00:00')`).run(uid).lastInsertRowid);
  const odysseyId = Number(db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,poster_path,vote_average,runtime,release_date,genres,collection_id,collection_name,points,is_rewatch,source,watched_at)
    VALUES (?,999,'The Odyssey','/odyssey.jpg',8.2,180,'2026-01-01','["Adventure"]',77,'Epic',123,0,'manual',?)`).run(uid, `${placeholderDate} 09:00:00`).lastInsertRowid);
  db.prepare("INSERT INTO achievements (user_id,key,name,points) VALUES (?,'keeper','Keeper',200)").run(uid);
  await importHistory(uid, "plex", [event(501, "2020-02-03T21:15:00Z", "history-501")], getMovie, { connectionId: "machine:subject" });

  const odysseyBefore = db.prepare("SELECT * FROM watches WHERE id=?").get(odysseyId);
  const unselectedSameMovieBefore = db.prepare("SELECT * FROM watches WHERE id=?").get(unselectedSameMovieId);
  const achievementBefore = db.prepare("SELECT * FROM achievements WHERE user_id=?").all(uid);
  const preview = previewPlaceholderReconciliation(uid, uid, placeholderDate);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].manual_watch_id, selectedId);
  assert.deepEqual(db.prepare("SELECT * FROM watches WHERE id=?").get(odysseyId), odysseyBefore, "preview mutates nothing");

  const applied = applyPlaceholderReconciliation(uid, uid, { nonce: preview.nonce, previewHash: preview.preview_hash, candidateIds: [preview.candidates[0].candidate_id] });
  assert.deepEqual(applied.row_ids, [selectedId]);
  const selected = db.prepare("SELECT * FROM watches WHERE id=?").get(selectedId);
  assert.equal(selected.watched_at, "2020-02-03 21:15:00");
  assert.equal(selected.source, "plex");
  assert.equal(selected.provider_event_id, null);
  const reconciledProvider = db.prepare("SELECT deleted_at,deleted_reason,provider_event_id,logical_canonical_watch_id FROM watches WHERE provider_event_id=?").get("plex:machine:subject:history-501");
  assert.ok(reconciledProvider.deleted_at);
  assert.equal(reconciledProvider.deleted_reason, "placeholder_reconciled");
  assert.equal(reconciledProvider.logical_canonical_watch_id, selectedId);
  assert.deepEqual(db.prepare("SELECT * FROM watches WHERE id=?").get(odysseyId), odysseyBefore);
  const unselectedSameMovieAfter = db.prepare("SELECT * FROM watches WHERE id=?").get(unselectedSameMovieId);
  for (const field of ["id", "user_id", "tmdb_id", "title", "poster_path", "vote_average", "runtime", "release_date", "genres", "collection_id", "collection_name", "source", "watched_at", "provider_service", "provider_connection_id", "provider_event_id", "deleted_at"]) {
    assert.deepEqual(unselectedSameMovieAfter[field], unselectedSameMovieBefore[field], `reconciliation must preserve unmatched manual ${field}`);
  }
  assert.deepEqual(db.prepare("SELECT * FROM achievements WHERE user_id=?").all(uid), achievementBefore);
  assert.equal(watchesOf(uid).filter((row) => row.tmdb_id === 501 && row.deleted_at === null).length, 2);
  assert.throws(() => applyPlaceholderReconciliation(uid, uid, { nonce: preview.nonce, previewHash: preview.preview_hash, candidateIds: [preview.candidates[0].candidate_id] }), /already used|invalid/i);

  const audit = db.prepare("SELECT * FROM audit_log WHERE action='reconcile_placeholders' AND target_id=? ORDER BY id DESC LIMIT 1").get(uid);
  assert.deepEqual(Object.keys(JSON.parse(audit.detail)).sort(), ["actor_user_id", "provider_row_ids", "row_ids", "target_user_id", "timestamps"]);
});

test("reconciliation leaves an unselected same-second provider row byte-for-byte unchanged", async () => {
  const uid = makeUser("reconcile_same_second");
  const placeholderDate = "2026-07-27";
  db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at) VALUES (?,777,'Film 777 A',49,'manual',?)`)
    .run(uid, `${placeholderDate} 08:00:00`);
  db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at) VALUES (?,777,'Film 777 B',49,'manual',?)`)
    .run(uid, `${placeholderDate} 09:00:00`);
  await importHistory(uid, "plex", [
    event(777, "2020-01-01T00:00:00Z", "a"),
    event(777, "2020-01-01T00:00:00Z", "b"),
  ], getMovie, { connectionId: "machine:subject" });

  const preview = previewPlaceholderReconciliation(uid, uid, placeholderDate);
  assert.equal(preview.candidates.length, 2);
  const selected = preview.candidates[0];
  const unselectedProviderId = preview.candidates[1].provider_watch_id;
  const unselectedBefore = db.prepare("SELECT * FROM watches WHERE id=?").get(unselectedProviderId);
  applyPlaceholderReconciliation(uid, uid, {
    nonce: preview.nonce,
    previewHash: preview.preview_hash,
    candidateIds: [selected.candidate_id],
  });
  const unselectedAfter = db.prepare("SELECT * FROM watches WHERE id=?").get(unselectedProviderId);
  for (const field of ["id", "user_id", "tmdb_id", "title", "poster_path", "vote_average", "runtime", "release_date", "genres", "collection_id", "collection_name", "source", "watched_at", "provider_service", "provider_connection_id", "provider_event_id", "deleted_at"]) {
    assert.deepEqual(unselectedAfter[field], unselectedBefore[field], `reconciliation must preserve unselected ${field}`);
  }
  assert.equal(unselectedAfter.eligibility_reason, "rewatch_cooldown");
});


test("stale reconciliation preview is rejected without partial mutation", async () => {
  const uid = makeUser("stale");
  const manualId = Number(db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at) VALUES (?,601,'Film 601',49,'manual','2026-07-27 10:00:00')`).run(uid).lastInsertRowid);
  await importHistory(uid, "trakt", [event(601, "2020-01-01T00:00:00Z", "history-601")], getMovie, { connectionId: "subject" });
  const preview = previewPlaceholderReconciliation(uid, uid, "2026-07-27");
  db.prepare("UPDATE watches SET watched_at='2026-07-27 11:00:00' WHERE id=?").run(manualId);
  assert.throws(() => applyPlaceholderReconciliation(uid, uid, { nonce: preview.nonce, previewHash: preview.preview_hash, candidateIds: [preview.candidates[0].candidate_id] }), /stale/i);
  assert.equal(db.prepare("SELECT source FROM watches WHERE id=?").get(manualId).source, "manual");
});


test("reconciliation pairs a placeholder with the newest authoritative provider event", async () => {
  const uid = makeUser("newest");
  db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at)
    VALUES (?,602,'Film 602',49,'manual','2026-07-27 10:00:00')`).run(uid);
  await importHistory(uid, "plex", [
    event(602, "2019-01-01T00:00:00Z", "older"),
    event(602, "2024-06-01T00:00:00Z", "newer"),
  ], getMovie, { connectionId: "machine:subject" });
  const preview = previewPlaceholderReconciliation(uid, uid, "2026-07-27");
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].provider_watched_at, "2024-06-01 00:00:00");
});


test("unknown metadata fails without inserting and URL normalization stays strict", async () => {
  const uid = makeUser("fail");
  const result = await importHistory(uid, "trakt", [event(701, "2020-01-01T10:00:00Z", "id")], async () => { throw new Error("404"); }, { connectionId: "acct" });
  assert.equal(result.failed, 1);
  assert.equal(watchesOf(uid).length, 0);
  assert.equal(normalizePlexUrl("http://plex.local:32400/"), "http://plex.local:32400");
  assert.equal(normalizePlexUrl("file:///etc/passwd"), null);
});
