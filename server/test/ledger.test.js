process.env.DATA_DIR = `/tmp/rs-ledger-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { db, currentStreak } = await import("../src/db.js");
const { awardScoreEvent, reverseScoreEvents, scoreBreakdown, totalScore } = await import("../src/repositories/score-ledger.js");
const { reconcileMovieEligibility, scoreWatchEvent } = await import("../src/services/scoring-service.js");
const { evaluate, progress } = await import("../src/achievements.js");

function makeUser(prefix) {
  return Number(db.prepare("INSERT INTO users (username,password_hash) VALUES (?, 'x')")
    .run(`${prefix}_${Date.now()}_${Math.random()}`).lastInsertRowid);
}

function insertWatch(userId, { tmdbId = 42, title = `Film ${tmdbId}`, voteAverage = 7, runtime = 120, watchedAt = "2026-01-01T00:00:00.000Z" } = {}) {
  const watched = watchedAt.replace("T", " ").replace(".000Z", "");
  return Number(db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,vote_average,runtime,points,is_rewatch,source,watched_at,
     watched_at_utc,watched_day_local,timezone_used)
    VALUES (?,?,?,?,?,0,0,'manual',?,?,substr(?,1,10),'UTC')`)
    .run(userId, tmdbId, title, voteAverage, runtime, watched, watchedAt, watchedAt).lastInsertRowid);
}

function eventsFor(userId) {
  return db.prepare("SELECT * FROM score_events WHERE user_id=? ORDER BY id").all(userId);
}

test("awardScoreEvent is idempotent and rejects an immutable event-key conflict", () => {
  const userId = makeUser("award");
  const input = { eventKey: `test/award/${userId}`, userId, category: "test_bonus", points: 25, ruleVersion: "test-v1", metadata: { reason: "test", input: 1 }, createdAt: "2026-01-01T00:00:00Z" };
  const first = awardScoreEvent(input);
  const repeated = awardScoreEvent(input);
  assert.equal(repeated.id, first.id);
  assert.equal(eventsFor(userId).length, 1);
  assert.throws(() => awardScoreEvent({ ...input, points: 26 }), /event key conflict/i);
  assert.throws(() => awardScoreEvent({ ...input, createdAt: "2026-01-02T00:00:00Z" }), /event key conflict/i);
});

test("ledger boundaries reject invalid identifiers, strings, timestamps, and reversal input", () => {
  const userId = makeUser("invalid_ledger");
  const valid = { eventKey: `test/invalid/${userId}`, userId, category: "test", points: 1, ruleVersion: "test-v1", metadata: {} };
  for (const invalid of [
    { ...valid, userId: 0 },
    { ...valid, userId: true },
    { ...valid, watchId: "1" },
    { ...valid, watchId: -1 },
    { ...valid, achievementId: 1.5 },
    { ...valid, seasonId: 0 },
    { ...valid, reversesEventId: "nope" },
    { ...valid, points: null },
    { ...valid, points: false },
    { ...valid, points: "  " },
    { ...valid, points: true },
    { ...valid, category: undefined },
    { ...valid, ruleVersion: "  " },
    { ...valid, createdAt: "01/10/2026 20:00:00" },
  ]) assert.throws(() => awardScoreEvent(invalid), /positive integer|integer number|non-empty string|timestamp|UTC instant/i);
  assert.throws(() => reverseScoreEvents({ userId, eventIds: [0], reason: "bad" }), /positive integer/i);
  assert.throws(() => reverseScoreEvents({ userId, eventIds: [], reason: "bad", reversedAt: "tomorrow" }), /timestamp|UTC instant/i);
});

test("reverseScoreEvents is atomic and idempotent while lifetime totals include compensation rows", () => {
  const userId = makeUser("reverse");
  const award = awardScoreEvent({ eventKey: `test/reverse/${userId}`, userId, category: "test_bonus", points: 40, ruleVersion: "test-v1", metadata: { reason: "test reversal" } });
  const first = reverseScoreEvents({ userId, eventIds: [award.id], reason: "fixture removed" });
  const repeated = reverseScoreEvents({ userId, eventIds: [award.id], reason: "fixture removed" });
  assert.equal(first[0].id, repeated[0].id);
  assert.equal(first[0].points, -40);
  assert.equal(first[0].reverses_event_id, award.id);
  assert.ok(db.prepare("SELECT reversed_at FROM score_events WHERE id=?").get(award.id).reversed_at);
  assert.equal(totalScore(userId), 0);
  assert.deepEqual(eventsFor(userId).map((row) => row.points), [40, -40]);
});

test("lifetime totals remain separate from future season rows and expose a category breakdown", () => {
  const userId = makeUser("season");
  awardScoreEvent({ eventKey: `test/lifetime/${userId}`, userId, category: "watch_first", points: 49, ruleVersion: "test-v1", metadata: {} });
  awardScoreEvent({ eventKey: `test/season/${userId}`, userId, seasonId: 9, category: "watch_first", points: 12, ruleVersion: "test-v1", metadata: {} });
  assert.equal(totalScore(userId), 49);
  assert.equal(totalScore(userId, { seasonId: 9 }), 12);
  assert.deepEqual(scoreBreakdown(userId), [{ category: "watch_first", points: 49 }]);
});

test("watch scoring records first, zero-point cooldown, and paid rewatch explanations from stored snapshots", () => {
  const userId = makeUser("watch");
  const firstId = insertWatch(userId, { watchedAt: "2026-01-01T00:00:00.000Z" });
  const cooldownId = insertWatch(userId, { watchedAt: "2026-01-10T00:00:00.000Z" });
  const rewatchId = insertWatch(userId, { watchedAt: "2026-03-01T00:00:00.000Z" });
  scoreWatchEvent(firstId);
  const awards = eventsFor(userId).filter((row) => row.reverses_event_id == null);
  assert.deepEqual(awards.map((row) => [row.watch_id, row.category, row.points]), [[firstId, "watch_first", 49], [cooldownId, "watch_cooldown", 0], [rewatchId, "watch_rewatch", 12]]);
  const cooldownMetadata = JSON.parse(awards[1].metadata_json);
  assert.equal(cooldownMetadata.reason, "rewatch_cooldown");
  assert.equal(cooldownMetadata.calculation.base_points, 49);
  assert.deepEqual(cooldownMetadata.inputs, { vote_average: 7, runtime: 120 });
  assert.equal(totalScore(userId), 61);
});

test("late import reverses and reissues only affected current awards deterministically", () => {
  const userId = makeUser("late");
  const futureId = insertWatch(userId, { tmdbId: 77, watchedAt: "2030-01-01T00:00:00.000Z" });
  scoreWatchEvent(futureId);
  const original = eventsFor(userId)[0];
  const pastId = insertWatch(userId, { tmdbId: 77, watchedAt: "2020-01-01T00:00:00.000Z" });
  reconcileMovieEligibility(userId, [77]);
  reconcileMovieEligibility(userId, [77]);
  const active = eventsFor(userId).filter((row) => row.reverses_event_id == null && row.reversed_at == null);
  assert.deepEqual(active.map((row) => [row.watch_id, row.category, row.points]), [[pastId, "watch_first", 49], [futureId, "watch_rewatch", 12]]);
  assert.ok(db.prepare("SELECT reversed_at FROM score_events WHERE id=?").get(original.id).reversed_at);
  assert.equal(eventsFor(userId).filter((row) => row.reverses_event_id != null).length, 1);
  assert.equal(totalScore(userId), 61);
});

test("soft deletion reverses the deleted award and restores the surviving watch score", () => {
  const userId = makeUser("delete");
  const firstId = insertWatch(userId, { tmdbId: 88, watchedAt: "2026-01-01T00:00:00.000Z" });
  const secondId = insertWatch(userId, { tmdbId: 88, watchedAt: "2026-01-10T00:00:00.000Z" });
  scoreWatchEvent(firstId);
  assert.equal(totalScore(userId), 49);
  db.prepare("UPDATE watches SET deleted_at='2026-04-01T00:00:00.000Z',deleted_reason='user_deleted' WHERE id=?").run(firstId);
  reconcileMovieEligibility(userId, [88]);
  reconcileMovieEligibility(userId, [88]);
  const active = eventsFor(userId).filter((row) => row.reverses_event_id == null && row.reversed_at == null);
  assert.deepEqual(active.map((row) => [row.watch_id, row.category, row.points]), [[secondId, "watch_first", 49]]);
  assert.equal(db.prepare("SELECT points FROM watches WHERE id=?").get(firstId).points, 0);
  assert.equal(db.prepare("SELECT points FROM watches WHERE id=?").get(secondId).points, 49);
  assert.equal(totalScore(userId), 49);
});

test("unchanged migrated awards preserve historical points even when they differ from the current formula", () => {
  const userId = makeUser("legacy_watch");
  const watchId = insertWatch(userId, { tmdbId: 109, watchedAt: "2026-01-01T00:00:00.000Z" });
  db.prepare(`UPDATE watches SET points=37,logical_canonical_watch_id=id,qualifies_for_volume=1,
    qualifies_for_achievement=1,qualifies_for_streak=1,qualifies_for_season=1,
    eligibility_status='legacy_assumed',eligibility_rule_version='competition-v1-backfill',
    eligibility_reason='legacy_canonical_first_watch' WHERE id=?`).run(watchId);
  const legacy = awardScoreEvent({
    eventKey: `legacy/watch/${watchId}`,
    userId,
    watchId,
    category: "legacy_watch",
    points: 37,
    ruleVersion: "legacy-v1",
    metadata: { stored_points: 37, backfilled: true },
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  reconcileMovieEligibility(userId, [109]);
  assert.equal(db.prepare("SELECT reversed_at FROM score_events WHERE id=?").get(legacy.id).reversed_at, null);
  assert.equal(db.prepare("SELECT points FROM watches WHERE id=?").get(watchId).points, 37);
  assert.equal(totalScore(userId), 37);

  db.prepare("UPDATE watches SET deleted_at='2026-04-01T00:00:00.000Z',deleted_reason='user_deleted' WHERE id=?").run(watchId);
  reconcileMovieEligibility(userId, [109]);
  const reversal = db.prepare("SELECT * FROM score_events WHERE reverses_event_id=?").get(legacy.id);
  assert.equal(reversal.points, -37);
  assert.equal(totalScore(userId), 0);
});

test("equal-point legacy awards are still reissued when eligibility category changes", () => {
  const userId = makeUser("legacy_zero_transition");
  const futureId = insertWatch(userId, { tmdbId: 110, voteAverage: 0, watchedAt: "2026-01-10T00:00:00.000Z" });
  db.prepare(`UPDATE watches SET logical_canonical_watch_id=id,qualifies_for_volume=1,
    qualifies_for_achievement=1,qualifies_for_streak=1,qualifies_for_season=1,
    eligibility_status='legacy_assumed',eligibility_rule_version='competition-v1-backfill',
    eligibility_reason='legacy_canonical_first_watch' WHERE id=?`).run(futureId);
  const legacy = awardScoreEvent({ eventKey: `legacy/watch/${futureId}`, userId, watchId: futureId,
    category: "legacy_watch", points: 0, ruleVersion: "legacy-v1", metadata: { stored_points: 0, backfilled: true },
    createdAt: "2026-01-10T00:00:00.000Z" });
  const earlierId = insertWatch(userId, { tmdbId: 110, voteAverage: 0, watchedAt: "2026-01-01T00:00:00.000Z" });

  reconcileMovieEligibility(userId, [110]);
  assert.ok(db.prepare("SELECT reversed_at FROM score_events WHERE id=?").get(legacy.id).reversed_at);
  assert.ok(db.prepare("SELECT 1 FROM score_events WHERE reverses_event_id=?").get(legacy.id));
  assert.deepEqual(db.prepare(`SELECT watch_id,category,points FROM score_events
    WHERE user_id=? AND reversed_at IS NULL AND reverses_event_id IS NULL ORDER BY watch_id`).all(userId), [
    { watch_id: futureId, category: "watch_cooldown", points: 0 },
    { watch_id: earlierId, category: "watch_first", points: 0 },
  ]);
});

test("soft-deleted watches stop contributing to the current streak projection", () => {
  const userId = makeUser("deleted_streak");
  const watchId = insertWatch(userId, { tmdbId: 111, watchedAt: new Date().toISOString() });
  assert.equal(currentStreak(userId), 1);
  db.prepare("UPDATE watches SET deleted_at=datetime('now'),deleted_reason='user_deleted' WHERE id=?").run(watchId);
  assert.equal(currentStreak(userId), 0);
});

test("later TMDB metadata changes cannot alter an existing ledger award snapshot", () => {
  const userId = makeUser("snapshot");
  const watchId = insertWatch(userId, { tmdbId: 99, voteAverage: 7, runtime: 120 });
  scoreWatchEvent(watchId);
  const before = db.prepare("SELECT * FROM score_events WHERE watch_id=? AND reverses_event_id IS NULL").get(watchId);
  reconcileMovieEligibility(userId, [99]);
  const after = db.prepare("SELECT * FROM score_events WHERE id=?").get(before.id);
  assert.deepEqual(after, before);
  assert.deepEqual(JSON.parse(after.metadata_json).inputs, { vote_average: 7, runtime: 120 });
});


test("runtime achievement unlocks append achievement ledger awards", async () => {
  const userId = makeUser("achievement_compat");
  const watchId = insertWatch(userId, { tmdbId: 123 });
  scoreWatchEvent(watchId);
  const unlocked = await evaluate(userId, { collection_id: null, person_ids: [] });
  assert.ok(unlocked.some((achievement) => achievement.key === "volume:1"));
  const achievement = db.prepare("SELECT * FROM achievements WHERE user_id=? AND key='volume:1'").get(userId);
  const event = db.prepare("SELECT * FROM score_events WHERE id=?").get(achievement.score_event_id);
  assert.equal(event.achievement_id, achievement.id);
  assert.equal(event.category, "achievement");
  assert.equal(event.points, 25);
  assert.equal(totalScore(userId), 74);
});

test("achievement progress projections exclude soft-deleted watches", () => {
  const userId = makeUser("deleted_progress");
  const activeId = insertWatch(userId, { tmdbId: 201 });
  const deletedId = insertWatch(userId, { tmdbId: 202 });
  db.prepare("UPDATE watches SET release_date='2001-01-01' WHERE id=?").run(activeId);
  db.prepare("UPDATE watches SET release_date='1991-01-01' WHERE id=?").run(deletedId);
  scoreWatchEvent(activeId);
  scoreWatchEvent(deletedId);
  db.prepare("UPDATE watches SET deleted_at=datetime('now'),deleted_reason='user_deleted' WHERE id=?").run(deletedId);
  reconcileMovieEligibility(userId, [202]);
  const projected = progress(userId);
  assert.equal(projected.volume, 1);
  assert.equal(projected.decades, 1);
});
