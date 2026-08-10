process.env.DATA_DIR = `/tmp/rs-streak-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, parseCookies } from "./helpers/server.js";

const { db } = await import("../src/db.js");
const { currentStreak } = await import("../src/services/streak-service.js");
const { applyPreparedUserSettingsUpdate, prepareUserSettingsUpdate, updateUserSettings } = await import("../src/services/user-settings-service.js");

function makeUser(prefix, timezone = "UTC", publicProfile = false) {
  return Number(db.prepare("INSERT INTO users (username,password_hash,timezone,public_profile) VALUES (?, 'x', ?, ?)")
    .run(`${prefix}_${Date.now()}_${Math.random()}`, timezone, publicProfile ? 1 : 0).lastInsertRowid);
}

function watch(userId, day, { qualifies = 1, deleted = false, tmdbId = Math.floor(Math.random() * 1e9) } = {}) {
  const instant = `${day}T12:00:00.000Z`;
  return Number(db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,points,source,watched_at,watched_at_utc,watched_day_local,timezone_used,
     qualifies_for_streak,deleted_at)
    VALUES (?,?,'Fixture',0,'manual',?,?,?,?,?,?)`)
    .run(userId, tmdbId, instant.replace("T", " ").replace(".000Z", ""), instant, day,
      db.prepare("SELECT timezone FROM users WHERE id=?").get(userId).timezone,
      qualifies, deleted ? `${day}T13:00:00.000Z` : null).lastInsertRowid);
}

let srv;
let apiUserId;
let cookie;
let csrf;

before(async () => {
  srv = await startTestServer();
  const response = await fetch(`${srv.base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `timezone_api_${process.pid}`, password: "correct-horse-battery" }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  apiUserId = body.user.id;
  cookie = parseCookies(response).session;
  csrf = body.csrf_token;
});

after(async () => { if (srv) await srv.close(); });

test("current streak starts today or yesterday, walks calendar days, and ignores gaps", () => {
  const today = makeUser("today");
  watch(today, "2026-03-08"); watch(today, "2026-03-07"); watch(today, "2026-03-06");
  assert.equal(currentStreak(today, { asOf: "2026-03-08T23:00:00Z" }), 3);
  const yesterday = makeUser("yesterday");
  watch(yesterday, "2026-11-01"); watch(yesterday, "2026-10-31");
  assert.equal(currentStreak(yesterday, { asOf: "2026-11-02T12:00:00Z" }), 2);
  const gap = makeUser("gap");
  watch(gap, "2026-03-08"); watch(gap, "2026-03-06");
  assert.equal(currentStreak(gap, { asOf: "2026-03-08T12:00:00Z" }), 1);
  assert.equal(currentStreak(gap, { asOf: "2026-03-10T12:00:00Z" }), 0);
});

test("current streak uses distinct qualifying, non-deleted local days", () => {
  const userId = makeUser("projection");
  watch(userId, "2026-01-15"); watch(userId, "2026-01-15"); watch(userId, "2026-01-14");
  watch(userId, "2026-01-13", { qualifies: 0 }); watch(userId, "2026-01-12", { deleted: true });
  assert.equal(currentStreak(userId, { asOf: "2026-01-15T20:00:00Z" }), 2);
});

test("local midnight and Chicago DST spring/fall dates use calendar arithmetic", () => {
  const userId = makeUser("chicago", "America/Chicago");
  for (const day of ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]) watch(userId, day);
  assert.equal(currentStreak(userId, { asOf: "2026-03-09T05:30:00Z" }), 4);
  const fall = makeUser("chicago_fall", "America/Chicago");
  for (const day of ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]) watch(fall, day);
  assert.equal(currentStreak(fall, { asOf: "2026-11-02T06:30:00Z" }), 4);
});

test("different user zones produce different streaks at the same instant", () => {
  const chicago = makeUser("zone_chicago", "America/Chicago");
  const tokyo = makeUser("zone_tokyo", "Asia/Tokyo");
  watch(chicago, "2026-01-14"); watch(tokyo, "2026-01-14");
  const asOf = "2026-01-16T05:30:00Z";
  assert.equal(currentStreak(chicago, { asOf }), 1);
  assert.equal(currentStreak(tokyo, { asOf }), 0);
});

test("current streak strictly validates numeric IDs and explicit asOf instants", () => {
  const userId = makeUser("validation");
  for (const invalid of ["1", 0, -1, 1.5, true, null, undefined]) {
    assert.throws(() => currentStreak(invalid, { asOf: "2026-01-01T00:00:00Z" }), /positive integer number/i);
  }
  for (const invalid of ["2026-01-01", "2026-01-01T00:00:00", "not-a-date", 123]) {
    assert.throws(() => currentStreak(userId, { asOf: invalid }), /UTC instant/i);
  }
  assert.throws(() => currentStreak(999_999_999, { asOf: "2026-01-01T00:00:00Z" }), /user.*not found/i);
});

test("timezone update recomputes owned local days without changing immutable/import identity fields", async () => {
  const userId = makeUser("recompute");
  const original = { watched_at: "2026-01-15 01:30:00", watched_at_utc: "2026-01-15T01:30:00.000Z", source: "plex", provider_service: "plex", provider_connection_id: "machine:subject", provider_event_id: `plex:machine:subject:${userId}` };
  const watchId = Number(db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,points,source,watched_at,watched_at_utc,watched_day_local,timezone_used,
     provider_service,provider_connection_id,provider_event_id)
    VALUES (?,7001,'Imported',0,?,?,?,?,?,?,?,?)`)
    .run(userId, original.source, original.watched_at, original.watched_at_utc, "2026-01-15", "UTC",
      original.provider_service, original.provider_connection_id, original.provider_event_id).lastInsertRowid);
  const result = await updateUserSettings(userId, { timezone: "America/Chicago" });
  assert.deepEqual(result, { public_profile: false, timezone: "America/Chicago" });
  const row = db.prepare("SELECT * FROM watches WHERE id=?").get(watchId);
  assert.equal(row.watched_day_local, "2026-01-14");
  assert.equal(row.timezone_used, "America/Chicago");
  for (const [field, value] of Object.entries(original)) assert.equal(row[field], value, `${field} must be preserved exactly`);
});

test("settings preparation rejects invalid timezone without mutation and apply rollback is atomic", async () => {
  const userId = makeUser("rollback", "UTC", true);
  const watchId = watch(userId, "2026-01-15");
  await assert.rejects(updateUserSettings(userId, { timezone: "Mars/Olympus" }), /timezone/i);
  assert.deepEqual(db.prepare("SELECT timezone,public_profile FROM users WHERE id=?").get(userId), { timezone: "UTC", public_profile: 1 });
  const prepared = await prepareUserSettingsUpdate(userId, { timezone: "America/Chicago" });
  assert.deepEqual(prepared.preparedAchievements.fetched, [], "timezone updates must not perform dynamic TMDB reconciliation");
  assert.throws(() => applyPreparedUserSettingsUpdate(userId, prepared, { preparedAchievements: {} }), /prepared achievement reconciliation/i);
  assert.deepEqual(db.prepare("SELECT timezone,public_profile FROM users WHERE id=?").get(userId), { timezone: "UTC", public_profile: 1 });
  assert.deepEqual(db.prepare("SELECT watched_day_local,timezone_used FROM watches WHERE id=?").get(watchId), { watched_day_local: "2026-01-15", timezone_used: "UTC" });
});

test("settings API updates only explicit fields, returns private timezone, and never exposes timezone on profiles", async () => {
  const request = (body) => fetch(`${srv.base}/api/me/settings`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `session=${cookie}`, "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  let response = await request({ public_profile: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { public_profile: true, timezone: "UTC" });
  response = await request({ timezone: "Asia/Tokyo" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { public_profile: true, timezone: "Asia/Tokyo" });
  assert.deepEqual(db.prepare("SELECT public_profile,timezone FROM users WHERE id=?").get(apiUserId), { public_profile: 1, timezone: "Asia/Tokyo" });
  response = await request({ timezone: "Invalid/Zone" });
  assert.equal(response.status, 400);
  assert.deepEqual(db.prepare("SELECT public_profile,timezone FROM users WHERE id=?").get(apiUserId), { public_profile: 1, timezone: "Asia/Tokyo" });
  response = await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${cookie}` } });
  assert.equal((await response.json()).timezone, "Asia/Tokyo");
  response = await fetch(`${srv.base}/api/users/timezone_api_${process.pid}`, { headers: { Cookie: `session=${cookie}` } });
  const profile = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(profile, "timezone"), false);
});
