import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { importHistory } from "../src/sync.js";
import { normalizePlexUrl } from "../src/sync.js";

const fakeMovie = (id, over = {}) => ({
  id,
  title: `Film ${id}`,
  poster_path: null,
  vote_average: 7.0,
  runtime: 120,
  release_date: "2000-01-01",
  genres: [{ name: "Drama" }],
  belongs_to_collection: null,
  credits: { cast: [], crew: [] },
  ...over,
});
const getMovie = async (id) => fakeMovie(id);

function makeUser(name) {
  return db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')")
    .run(name).lastInsertRowid;
}
const watchesOf = (uid) =>
  db.prepare("SELECT * FROM watches WHERE user_id = ? ORDER BY watched_at").all(uid);

test("import inserts new watches with full points and service source", async () => {
  const uid = makeUser(`sync_new_${Date.now()}`);
  const r = await importHistory(uid, "trakt", [
    { tmdb_id: 101, watched_at: "2020-01-01 20:00:00" },
    { tmdb_id: 102, watched_at: "2021-06-15 21:30:00" },
  ], getMovie);
  assert.equal(r.imported, 2);
  assert.equal(r.verified, 0);
  const ws = watchesOf(uid);
  assert.equal(ws.length, 2);
  assert.ok(ws.every((w) => w.source === "trakt"));
  assert.ok(ws.every((w) => w.points > 0 && !w.is_rewatch));
  assert.equal(ws[0].watched_at, "2020-01-01 20:00:00");
});

test("same-day manual watch is verified in place, not duplicated", async () => {
  const uid = makeUser(`sync_verify_${Date.now()}`);
  db.prepare(
    `INSERT INTO watches (user_id, tmdb_id, title, points, source, watched_at)
     VALUES (?, 201, 'Film 201', 49, 'manual', '2022-03-03 10:00:00')`
  ).run(uid);
  const r = await importHistory(uid, "plex", [
    { tmdb_id: 201, watched_at: "2022-03-03 22:00:00" },
  ], getMovie);
  assert.equal(r.imported, 0);
  assert.equal(r.verified, 1);
  const ws = watchesOf(uid);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].source, "plex");
  assert.equal(ws[0].points, 49); // points untouched
});

test("already-synced same-day watch is skipped, different day imports as rewatch", async () => {
  const uid = makeUser(`sync_skip_${Date.now()}`);
  db.prepare(
    `INSERT INTO watches (user_id, tmdb_id, title, points, source, watched_at)
     VALUES (?, 301, 'Film 301', 49, 'trakt', '2022-03-03 10:00:00')`
  ).run(uid);
  const r = await importHistory(uid, "trakt", [
    { tmdb_id: 301, watched_at: "2022-03-03 11:00:00" }, // same day → skip
    { tmdb_id: 301, watched_at: "2023-01-01 11:00:00" }, // later → rewatch
  ], getMovie);
  assert.equal(r.skipped, 1);
  assert.equal(r.imported, 1);
  const ws = watchesOf(uid);
  assert.equal(ws.length, 2);
  assert.equal(ws[1].is_rewatch, 1);
});

test("duplicate plays within one payload collapse to one per film per day", async () => {
  const uid = makeUser(`sync_dupe_${Date.now()}`);
  const r = await importHistory(uid, "plex", [
    { tmdb_id: 401, watched_at: "2020-05-05 18:00:00" },
    { tmdb_id: 401, watched_at: "2020-05-05 23:00:00" },
  ], getMovie);
  assert.equal(r.imported, 1);
  assert.equal(watchesOf(uid).length, 1);
});

test("unknown movies are counted as failed and skipped", async () => {
  const uid = makeUser(`sync_fail_${Date.now()}`);
  const r = await importHistory(uid, "trakt", [
    { tmdb_id: 501, watched_at: "2020-01-01 10:00:00" },
  ], async () => { throw new Error("404"); });
  assert.equal(r.failed, 1);
  assert.equal(watchesOf(uid).length, 0);
});

test("normalizePlexUrl accepts http(s) origins only", () => {
  assert.equal(normalizePlexUrl("http://plex.local:32400/"), "http://plex.local:32400");
  assert.equal(normalizePlexUrl("https://plex.example.com/web/index"), "https://plex.example.com");
  assert.equal(normalizePlexUrl("file:///etc/passwd"), null);
  assert.equal(normalizePlexUrl("not a url"), null);
});
