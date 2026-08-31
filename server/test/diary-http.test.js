process.env.DATA_DIR = `/tmp/rs-diary-http-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, parseCookies } from "./helpers/server.js";

let server, db, insertWatch, owner, other, watchId;
const movie = (id) => ({ id, title: `HTTP ${id}`, vote_average: 7, runtime: 100, genres: [], credits: { cast: [], crew: [] } });

async function register(username) {
  const response = await fetch(`${server.base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "a sufficiently long password" }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  const cookies = parseCookies(response);
  return { id: db.prepare("SELECT id FROM users WHERE username=?").get(username).id,
    csrf: body.csrf_token, cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ") };
}
function request(path, account, { method = "GET", body, csrf = true } = {}) {
  return fetch(`${server.base}${path}`, { method, headers: { ...(account ? { cookie: account.cookie } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(account && csrf ? { "x-csrf-token": account.csrf } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}

before(async () => {
  ({ db } = await import("../src/db.js"));
  ({ insertWatch } = await import("../src/repositories/watch-repository.js"));
  server = await startTestServer();
  owner = await register("diaryowner"); other = await register("diaryother");
  watchId = insertWatch({ userId: owner.id, movie: movie(801), watchedAt: "2035-01-10T12:00:00.000Z" }).id;
});
after(async () => { if (server) await server.close(); });

test("diary GET and PATCH require authentication, ownership, and CSRF", async () => {
  assert.equal((await request(`/api/watches/${watchId}/diary`, null)).status, 401);
  assert.equal((await request(`/api/watches/${watchId}/diary`, other)).status, 404);
  assert.equal((await request(`/api/watches/${watchId}/diary`, owner, { method: "PATCH", body: { review: "x" }, csrf: false })).status, 403);
  const patched = await request(`/api/watches/${watchId}/diary`, owner, { method: "PATCH", body: { review: "Public review", private_notes: "OWNER-ONLY-SENTINEL" } });
  const patchedText = await patched.text();
  assert.equal(patched.status, 200, patchedText);
  assert.equal(JSON.parse(patchedText).private_notes, "OWNER-ONLY-SENTINEL");
  const got = await request(`/api/watches/${watchId}/diary`, owner);
  assert.equal(got.status, 200); assert.equal((await got.json()).private_notes, "OWNER-ONLY-SENTINEL");
});

test("diary PATCH strictly rejects malformed and unknown bodies with safe errors", async () => {
  for (const body of [[], null, {}, { unknown: true }, { personal_rating: "50" }, { watched_at_utc: "2035-02-29T12:00:00.000Z" }]) {
    const response = await request(`/api/watches/${watchId}/diary`, owner, { method: "PATCH", body });
    assert.equal(response.status, 400, `${JSON.stringify(body)} => ${response.status}`);
    const payload = await response.json(); assert.deepEqual(Object.keys(payload), ["error"]); assert.doesNotMatch(payload.error, /sqlite|select|trigger|stack/i);
  }
  const malformed = await request(`/api/watches/${watchId}/diary`, owner, { method: "PATCH", body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(Object.keys(await malformed.json()), ["error"]);
});

test("deleted and foreign diary IDs are indistinguishable", async () => {
  const foreign = insertWatch({ userId: other.id, movie: movie(802), watchedAt: "2035-01-10T12:00:00.000Z" }).id;
  const deleted = insertWatch({ userId: owner.id, movie: movie(803), watchedAt: "2035-01-10T12:00:00.000Z" }).id;
  db.prepare("UPDATE watches SET deleted_at='2035-01-11T00:00:00.000Z',deleted_reason='user_deleted' WHERE id=?").run(deleted);
  for (const id of [foreign, deleted, 999999]) {
    const get = await request(`/api/watches/${id}/diary`, owner); assert.equal(get.status, 404);
    const patch = await request(`/api/watches/${id}/diary`, owner, { method: "PATCH", body: { review: "x" } }); assert.equal(patch.status, 404);
  }
});

test("private notes do not leak through watch list, feed, or profile DTOs", async () => {
  db.prepare("UPDATE users SET public_profile=1 WHERE id=?").run(owner.id);
  db.prepare("INSERT INTO friends(user_id,friend_id,status,requested_by) VALUES (?,?, 'accepted',?)").run(Math.min(owner.id,other.id),Math.max(owner.id,other.id),owner.id);
  for (const path of ["/api/watches", "/api/feed", "/api/users/diaryowner"]) {
    const response = await request(path, other); const text = await response.text(); assert.equal(response.status, 200, `${path}: ${text}`); assert.equal(text.includes("OWNER-ONLY-SENTINEL"), false, path); assert.equal(text.includes("private_notes"), false, path);
  }
});
