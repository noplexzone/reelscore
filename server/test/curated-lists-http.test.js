process.env.DATA_DIR = `/tmp/rs-curated-lists-http-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, parseCookies } from "./helpers/server.js";

const STARTER_CANON_IDS = [
  19, 901, 630, 15, 289, 872, 346, 389, 539, 62, 238, 578, 44012,
  11, 348, 85, 78, 925, 329, 680, 129, 120, 598, 376867, 496243,
];
const EXPECTED_POSTERS = [
  "/kr9wXRN23zLuWJIelahas1mtnYj.jpg", "/ugmakEL5y294I5bXgiBqApuZpwc.jpg",
  "/uCC3j4pV9eOZwzDUWp2ilbcTf1f.jpg", "/sav0jxhqiH0bPr2vZFU0Kjt2nZL.jpg",
  "/lGCEKlJo2CnWydQj7aamY7s1S7Q.jpg", "/w03EiJVHP8Un77boQeE7hg9DVdU.jpg",
  "/lOMGc8bnSwQhS4XyE1S99uH8NXf.jpg", "/zhG3vKWyDRaZYoaww1UVAi29T9h.jpg",
  "/yz4QVqPx3h1hD1DfqqQkCq3rmxW.jpg", "/ve72VxNqjGM69Uky4WTo2bK6rfq.jpg",
  "/3bhkrj58Vtu7enYsRolD1fZdja1.jpg", "/lxM6kqilAdpdhqUl2biYp5frUxE.jpg",
  "/fqfSu8Y1YSVFkoCJyiTXI6woYma.jpg", "/fai0rspsNeJCS69wHNjOdWxcI7P.jpg",
  "/vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg", "/ceG9VzoRAVGwivFU403Wc3AHRys.jpg",
  "/63N9uy8nd9j7Eog2axPQ8lbr3Wj.jpg", "/63rmSDPahrH7C1gEFYzRuIBAN9W.jpg",
  "/63viWuPfYQjRYLSZSZNq7dglJP5.jpg", "/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg",
  "/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg", "/6oom5QYQ2yQTMJIbnvbkBL9cHo6.jpg",
  "/k7eYdWvhYQyRQoU2TB2A2Xu2TfD.jpg", "/qLnfEmPrDjJfPyyddLJPkXmshkp.jpg",
  "/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg",
];

let server;
let db;
let owner;
let other;
let completed;

async function register(username) {
  const response = await fetch(`${server.base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "a sufficiently long password" }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const cookies = parseCookies(response);
  return {
    id: db.prepare("SELECT id FROM users WHERE username=?").get(username).id,
    cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; "),
  };
}

function request(path, account) {
  return fetch(`${server.base}${path}`, {
    headers: account ? { cookie: account.cookie } : {},
  });
}

function addWatch(userId, tmdbId, { qualifies = true, deleted = false, source = "manual", title = `Film ${tmdbId}` } = {}) {
  const imported = source === "letterboxd";
  db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,points,source,watched_at,qualifies_for_achievement,deleted_at,private_notes,
     competition_eligibility,source_recorded_date,source_date_kind,import_source,import_event_key)
    VALUES (?,?,?,0,?,'2026-09-03 12:00:00',?,?,?,?,?,?,?,?)`).run(
    userId, tmdbId, title, source, qualifies ? 1 : 0,
    deleted ? "2026-09-03T13:00:00.000Z" : null,
    "PRIVATE-NOTE-SENTINEL", imported ? "unverified_import" : "eligible",
    imported ? "2026-09-03" : null, imported ? "watched_day" : null,
    imported ? "letterboxd" : null,
    imported ? `import:${userId}:${tmdbId}:${Math.random()}` : null,
  );
}

before(async () => {
  ({ db } = await import("../src/db.js"));
  server = await startTestServer();
  owner = await register("curated_owner");
  other = await register("curated_other");
  completed = await register("curated_complete");

  addWatch(owner.id, 19);
  addWatch(owner.id, 19); // duplicate qualifying rows count once
  addWatch(owner.id, 901);
  addWatch(owner.id, 630, { qualifies: false, source: "letterboxd" });
  addWatch(owner.id, 15, { deleted: true });
  addWatch(other.id, 289);
  for (const tmdbId of STARTER_CANON_IDS) addWatch(completed.id, tmdbId);
});

after(async () => {
  if (server) await server.close();
});

test("curated list endpoints retain normal authentication behavior", async () => {
  for (const path of ["/api/curated-lists", "/api/curated-lists/starter-canon"]) {
    const response = await request(path, null);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: "Sign in to continue." });
  }
});

test("summary exposes static catalog metadata and owner-scoped qualifying progress only", async () => {
  const response = await request("/api/curated-lists", owner);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(text.includes("PRIVATE-NOTE-SENTINEL"), false);
  assert.equal(text.includes("private_notes"), false);
  assert.equal(text.includes("import_source"), false);
  assert.deepEqual(JSON.parse(text), {
    lists: [{
      slug: "starter-canon",
      version: "v1",
      name: "ReelScore Starter Canon",
      award: {
        key: "curated-list:starter-canon:v1",
        points: 875,
        name: "ReelScore Starter Canon",
        description: "Watch all 25 films in the ReelScore Starter Canon",
      },
      watched: 2,
      total: 25,
      complete: false,
    }],
  });
});

test("detail preserves catalog order and marks only distinct active qualifying owner watches", async () => {
  const response = await request("/api/curated-lists/starter-canon", owner);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(text.includes("PRIVATE-NOTE-SENTINEL"), false);
  assert.equal(text.includes("letterboxd"), false);
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ["slug", "version", "name", "award", "watched", "total", "complete", "films"]);
  assert.equal(body.watched, 2);
  assert.equal(body.total, 25);
  assert.equal(body.complete, false);
  assert.deepEqual(body.films.map((film) => film.order), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.deepEqual(body.films.map((film) => film.tmdb_id), STARTER_CANON_IDS);
  assert.deepEqual(body.films.map((film) => film.poster_path), EXPECTED_POSTERS);
  assert.deepEqual(body.films.map((film) => film.watched), [true, true, ...Array(23).fill(false)]);
  assert.deepEqual(Object.keys(body.films[0]), ["order", "tmdb_id", "title", "year", "poster_path", "watched"]);
});

test("completed owner receives complete summary and detail state", async () => {
  const [summaryResponse, detailResponse] = await Promise.all([
    request("/api/curated-lists", completed),
    request("/api/curated-lists/starter-canon", completed),
  ]);
  assert.equal(summaryResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  const summary = await summaryResponse.json();
  const detail = await detailResponse.json();
  assert.deepEqual(
    { watched: summary.lists[0].watched, total: summary.lists[0].total, complete: summary.lists[0].complete },
    { watched: 25, total: 25, complete: true },
  );
  assert.equal(detail.watched, 25);
  assert.equal(detail.complete, true);
  assert.ok(detail.films.every((film) => film.watched));
});

test("unknown, encoded, and malformed slugs fail safely", async () => {
  for (const path of [
    "/api/curated-lists/not-a-list",
    "/api/curated-lists/starter-canon%2Fextra",
  ]) {
    const response = await request(path, owner);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "Curated list not found." });
  }
  const malformed = await request("/api/curated-lists/%E0%A4%A", owner);
  assert.equal(malformed.status, 400);
  const payload = await malformed.json();
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.doesNotMatch(payload.error, /sqlite|select|stack|private/i);
});
