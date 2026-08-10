process.env.DATA_DIR = `/tmp/rs-achievements-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const tmdbStub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const path = new URL(req.url, "http://stub").pathname;
  if (path === "/collection/900") return res.end(JSON.stringify({ id: 900, name: "Test Collection", parts: [
    { id: 701, release_date: "2020-01-01" }, { id: 702, release_date: "2021-01-01" },
  ] }));
  if (path === "/person/31/movie_credits") return res.end(JSON.stringify({ cast: [801, 802, 803].map((id, order) => ({
    id, title: `Credit ${id}`, release_date: "2020-01-01", genre_ids: [18], vote_count: 100, order, character: "Lead",
  })), crew: [] }));
  if (path === "/person/31") return res.end(JSON.stringify({ id: 31, name: "Test Person" }));
  res.statusCode = 503;
  res.end(JSON.stringify({ error: "unavailable" }));
});
await new Promise((resolve) => tmdbStub.listen(0, "127.0.0.1", resolve));
process.env.TMDB_API_KEY = "test-key";
process.env.TMDB_BASE_URL = `http://127.0.0.1:${tmdbStub.address().port}`;
test.after(() => new Promise((resolve) => tmdbStub.close(resolve)));

const { db } = await import("../src/db.js");
const { awardScoreEvent, totalScore } = await import("../src/repositories/score-ledger.js");
const { reconcileAchievements, achievementProgress, deleteWatchAndReconcileAchievements } = await import("../src/services/achievement-service.js");
const { logManualWatchAndReconcile } = await import("../src/services/manual-watch-service.js");

function makeUser(prefix) {
  return Number(db.prepare("INSERT INTO users (username,password_hash) VALUES (?, 'x')")
    .run(`${prefix}_${Date.now()}_${Math.random()}`).lastInsertRowid);
}

function watch(userId, {
  tmdbId, day = "2026-01-01", genre = "Drama", releaseDate = "2001-01-01",
  achievement = 1, streak = achievement, deleted = false, collectionId = null,
} = {}) {
  const result = db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,release_date,genres,collection_id,points,source,watched_at,
     watched_at_utc,watched_day_local,timezone_used,qualifies_for_volume,
     qualifies_for_achievement,qualifies_for_streak,qualifies_for_season,
     eligibility_status,eligibility_rule_version,eligibility_reason,deleted_at,deleted_reason)
    VALUES (?,?,?,?,?,?,0,'manual',?,?,?,?,?,?,?,?,?,?,?, ?,?)`).run(
    userId, tmdbId, `Film ${tmdbId}`, releaseDate, JSON.stringify([genre]), collectionId,
    `${day} 12:00:00`, `${day}T12:00:00.000Z`, day, "UTC", achievement, achievement,
    streak, streak, "evaluated", "competitive-v1", achievement ? "canonical_first_watch" : "rewatch_cooldown",
    deleted ? `${day}T13:00:00.000Z` : null, deleted ? "user_deleted" : null,
  );
  return Number(result.lastInsertRowid);
}

const achievement = (userId, key) => db.prepare("SELECT * FROM achievements WHERE user_id=? AND key=?").get(userId, key);
const awards = (userId, key) => db.prepare(`SELECT s.* FROM score_events s JOIN achievements a ON a.id=s.achievement_id
  WHERE a.user_id=? AND a.key=? AND s.reverses_event_id IS NULL ORDER BY s.id`).all(userId, key);

test("volume, genre, and decade progress count only qualifying, non-deleted watches", async () => {
  const userId = makeUser("qualified_progress");
  for (let i = 1; i <= 9; i++) watch(userId, { tmdbId: 100 + i, day: `2026-01-${String(i).padStart(2, "0")}` });
  watch(userId, { tmdbId: 101, day: "2026-02-01", achievement: 0 });
  watch(userId, { tmdbId: 999, day: "2026-02-02", achievement: 0 });
  watch(userId, { tmdbId: 1000, day: "2026-02-03", deleted: true });

  const first = await reconcileAchievements(userId);
  assert.ok(first.some((row) => row.key === "volume:1"));
  assert.equal(achievementProgress(userId).volume, 9);
  assert.equal(achievement(userId, "volume:10"), undefined);
  assert.equal(achievement(userId, "genre:Drama:10"), undefined);

  watch(userId, { tmdbId: 110, day: "2026-01-10" });
  const second = await reconcileAchievements(userId);
  assert.deepEqual(new Set(second.map((row) => row.key)), new Set(["volume:10", "genre:Drama:10"]));
  assert.equal(awards(userId, "volume:10").length, 1);
  assert.equal(awards(userId, "genre:Drama:10").length, 1);
  await reconcileAchievements(userId);
  assert.equal(awards(userId, "volume:10").length, 1);
});

test("zero-point achievement awards are retained and reconciled idempotently", async () => {
  const userId = makeUser("zero_award");
  watch(userId, { tmdbId: 201 });
  db.prepare(`INSERT INTO achievements (user_id,key,name,description,points)
    VALUES (?,'volume:1','Legacy zero','Imported zero award',0)`).run(userId);

  await reconcileAchievements(userId);
  await reconcileAchievements(userId);
  const row = achievement(userId, "volume:1");
  const events = awards(userId, "volume:1");
  assert.equal(events.length, 1);
  assert.equal(events[0].category, "achievement");
  assert.equal(events[0].points, 0);
  assert.equal(row.score_event_id, events[0].id);
  assert.equal(totalScore(userId), 0);
});

test("deleting the only basis revokes once and a new qualifying basis reactivates once", async () => {
  const userId = makeUser("reactivation");
  const firstWatch = watch(userId, { tmdbId: 301 });
  await reconcileAchievements(userId);
  const original = achievement(userId, "volume:1");
  assert.equal(totalScore(userId), 25);

  db.prepare("UPDATE watches SET deleted_at=?,deleted_reason='user_deleted',qualifies_for_achievement=0,qualifies_for_streak=0 WHERE id=?")
    .run("2026-02-01T00:00:00.000Z", firstWatch);
  await reconcileAchievements(userId);
  await reconcileAchievements(userId);
  const revoked = achievement(userId, "volume:1");
  assert.ok(revoked.revoked_at);
  assert.equal(revoked.revocation_reason, "achievement_basis_lost");
  assert.equal(totalScore(userId), 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE reverses_event_id=?").get(original.score_event_id).c, 1);

  watch(userId, { tmdbId: 302, day: "2026-02-02" });
  const reactivated = await reconcileAchievements(userId);
  await reconcileAchievements(userId);
  assert.deepEqual(reactivated.map((row) => row.key), ["volume:1"]);
  const active = achievement(userId, "volume:1");
  assert.equal(active.revoked_at, null);
  assert.notEqual(active.score_event_id, original.score_event_id);
  assert.equal(awards(userId, "volume:1").length, 2);
  assert.equal(totalScore(userId), 25);
});

test("legacy achievement awards are preserved while deserved and reversed when basis is lost", async () => {
  const userId = makeUser("legacy_award");
  const basis = watch(userId, { tmdbId: 401 });
  const achievementId = Number(db.prepare(`INSERT INTO achievements
    (user_id,key,name,description,points) VALUES (?,'volume:1','Opening Night','Log your first film',25)`).run(userId).lastInsertRowid);
  db.prepare(`INSERT INTO score_events
    (event_key,user_id,achievement_id,category,points,rule_version,metadata_json,created_at)
    VALUES (?,?,?,?,25,'legacy-v1','{}','2026-01-01T12:00:00.000Z')`)
    .run(`legacy/achievement/${achievementId}`, userId, achievementId, "legacy_achievement");
  const legacyEvent = db.prepare("SELECT * FROM score_events WHERE achievement_id=?").get(achievementId);
  db.prepare("UPDATE achievements SET score_event_id=? WHERE id=?").run(legacyEvent.id, achievementId);

  await reconcileAchievements(userId);
  assert.equal(achievement(userId, "volume:1").score_event_id, legacyEvent.id);
  assert.equal(awards(userId, "volume:1").length, 1);

  db.prepare("UPDATE watches SET deleted_at=?,qualifies_for_achievement=0,qualifies_for_streak=0 WHERE id=?")
    .run("2026-02-01T00:00:00.000Z", basis);
  await reconcileAchievements(userId);
  assert.ok(achievement(userId, "volume:1").revoked_at);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE reverses_event_id=?").get(legacyEvent.id).c, 1);
  assert.equal(totalScore(userId), 0);
});

test("streak trophies use the maximum historical run of qualifying stored local days", async () => {
  const userId = makeUser("historical_streak");
  const middle = watch(userId, { tmdbId: 502, day: "2020-01-02" });
  watch(userId, { tmdbId: 501, day: "2020-01-01" });
  watch(userId, { tmdbId: 503, day: "2020-01-03" });
  watch(userId, { tmdbId: 504, day: "2020-01-04", streak: 0, achievement: 0 });

  await reconcileAchievements(userId);
  assert.ok(achievement(userId, "streak:3"));
  assert.equal(achievementProgress(userId).streak, 3);

  db.prepare("UPDATE watches SET deleted_at=?,qualifies_for_achievement=0,qualifies_for_streak=0 WHERE id=?")
    .run("2026-02-01T00:00:00.000Z", middle);
  await reconcileAchievements(userId);
  assert.ok(achievement(userId, "streak:3").revoked_at);
});


test("series and filmography achievements require every qualifying film and revoke on basis loss", async () => {
  const seriesUser = makeUser("series_qualifying");
  watch(seriesUser, { tmdbId: 701, collectionId: 900 });
  const excludedSeriesFilm = watch(seriesUser, { tmdbId: 702, collectionId: 900, achievement: 0 });
  await reconcileAchievements(seriesUser, { collectionIds: [900] });
  assert.equal(achievement(seriesUser, "series:900"), undefined);
  db.prepare("UPDATE watches SET qualifies_for_achievement=1 WHERE id=?").run(excludedSeriesFilm);
  await reconcileAchievements(seriesUser, { collectionIds: [900] });
  assert.equal(achievement(seriesUser, "series:900").revoked_at, null);
  db.prepare("UPDATE watches SET qualifies_for_achievement=0,deleted_at=datetime('now'),deleted_reason='user_deleted' WHERE id=?").run(excludedSeriesFilm);
  await reconcileAchievements(seriesUser);
  assert.ok(achievement(seriesUser, "series:900").revoked_at);

  const personUser = makeUser("person_qualifying");
  watch(personUser, { tmdbId: 801 });
  watch(personUser, { tmdbId: 802 });
  const excludedPersonFilm = watch(personUser, { tmdbId: 803, achievement: 0 });
  await reconcileAchievements(personUser, { personIds: [31] });
  assert.equal(achievement(personUser, "person:31"), undefined);
  db.prepare("UPDATE watches SET qualifies_for_achievement=1 WHERE id=?").run(excludedPersonFilm);
  await reconcileAchievements(personUser, { personIds: [31] });
  assert.equal(achievement(personUser, "person:31").revoked_at, null);
  db.prepare("UPDATE watches SET qualifies_for_achievement=0,deleted_at=datetime('now'),deleted_reason='user_deleted' WHERE id=?").run(excludedPersonFilm);
  await reconcileAchievements(personUser);
  assert.ok(achievement(personUser, "person:31").revoked_at);
});

test("an external metadata outage preserves existing series awards", async () => {
  const userId = makeUser("external_outage");
  const achievementId = Number(db.prepare(`INSERT INTO achievements
    (user_id,key,name,description,points) VALUES (?,'series:901','Existing series','Existing basis',300)`).run(userId).lastInsertRowid);
  const event = awardScoreEvent({ eventKey: `test/external-outage/${achievementId}`, userId, achievementId,
    category: "achievement", points: 300, ruleVersion: "test-v1", metadata: {}, createdAt: "2026-01-01T00:00:00Z" });
  db.prepare("UPDATE achievements SET score_event_id=? WHERE id=?").run(event.id, achievementId);
  await reconcileAchievements(userId);
  assert.equal(achievement(userId, "series:901").revoked_at, null);
  assert.equal(db.prepare("SELECT reversed_at FROM score_events WHERE id=?").get(event.id).reversed_at, null);
});

test("achievement service boundaries reject coercible and malformed identifiers", async () => {
  const userId = makeUser("achievement_boundary");
  await assert.rejects(reconcileAchievements(String(userId)), /positive integer number/i);
  await assert.rejects(reconcileAchievements(userId, { collectionIds: ["900"] }), /positive integer number/i);
  await assert.rejects(reconcileAchievements(userId, { personIds: true }), /must be arrays/i);
  assert.throws(() => achievementProgress(true), /positive integer number/i);
});


test("watch deletion and achievement reversal roll back together and retry idempotently", async () => {
  const userId = makeUser("atomic_delete");
  const watchId = watch(userId, { tmdbId: 9901 });
  await reconcileAchievements(userId);
  const row = achievement(userId, "volume:1");
  db.exec(`CREATE TRIGGER force_achievement_reversal_failure BEFORE UPDATE OF revoked_at ON achievements
    BEGIN SELECT RAISE(ABORT,'forced achievement failure'); END`);
  await assert.rejects(deleteWatchAndReconcileAchievements(userId, watchId), /forced achievement failure/i);
  assert.equal(db.prepare("SELECT deleted_at FROM watches WHERE id=?").get(watchId).deleted_at, null);
  assert.equal(achievement(userId, "volume:1").revoked_at, null);
  assert.equal(db.prepare("SELECT reversed_at FROM score_events WHERE id=?").get(row.score_event_id).reversed_at, null);
  db.exec("DROP TRIGGER force_achievement_reversal_failure");

  assert.ok(await deleteWatchAndReconcileAchievements(userId, watchId));
  assert.ok(await deleteWatchAndReconcileAchievements(userId, watchId));
  assert.ok(db.prepare("SELECT deleted_at FROM watches WHERE id=?").get(watchId).deleted_at);
  assert.ok(achievement(userId, "volume:1").revoked_at);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE reverses_event_id=?").get(row.score_event_id).c, 1);
});


test("manual logging fails closed on unknown dynamic basis and commits the watch and trophy atomically on retry", async () => {
  const outageUser = makeUser("manual_dynamic_outage");
  const unavailable = { id: 9901, title: "Unavailable basis", vote_average: 7, runtime: 120,
    release_date: "2020-01-01", genres: [{ name: "Drama" }],
    belongs_to_collection: { id: 999, name: "Unavailable Collection" }, credits: { cast: [], crew: [] } };
  await assert.rejects(() => logManualWatchAndReconcile(outageUser, unavailable), (error) => error.status === 502);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM watches WHERE user_id=?").get(outageUser).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM score_events WHERE user_id=?").get(outageUser).count, 0);

  const completionUser = makeUser("manual_dynamic_completion");
  watch(completionUser, { tmdbId: 701, collectionId: 900 });
  const completingMovie = { id: 702, title: "Collection finale", vote_average: 7, runtime: 120,
    release_date: "2021-01-01", genres: [{ name: "Drama" }],
    belongs_to_collection: { id: 900, name: "Test Collection" }, credits: { cast: [], crew: [] } };
  const result = await logManualWatchAndReconcile(completionUser, completingMovie, { watchedAt: "2026-02-01T12:00:00Z" });
  assert.equal(result.watch.id > 0, true);
  assert.ok(result.achievements.some((row) => row.key === "series:900"));
  assert.equal(achievement(completionUser, "series:900").revoked_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM score_events WHERE user_id=? AND achievement_id IS NOT NULL").get(completionUser).count > 0, true);
});
