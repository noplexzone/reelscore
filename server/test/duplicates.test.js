process.env.DATA_DIR = `/tmp/rs-duplicates-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, parseCookies } from "./helpers/server.js";
const { db } = await import("../src/db.js");
const { importHistory } = await import("../src/sync.js");
const { insertWatch } = await import("../src/repositories/watch-repository.js");
const { reconcileMovieEligibility } = await import("../src/services/scoring-service.js");
const { applyPreparedAchievementReconciliation, prepareStaticAchievementReconciliation, deleteWatchAndReconcileAchievements } = await import("../src/services/achievement-service.js");
const { updateUserSettings } = await import("../src/services/user-settings-service.js");
const { totalScore } = await import("../src/repositories/score-ledger.js");
const { duplicateFingerprint, getDuplicateCases, resolveDuplicateCase } = await import("../src/services/duplicate-service.js");

const movie = (id, over = {}) => ({ id, title: `Film ${id}`, poster_path: `/film-${id}.jpg`, vote_average: 7, runtime: 120, release_date: "2000-01-01", genres: [{ name: "Drama" }], belongs_to_collection: null, credits: { cast: [], crew: [] }, ...over });
const event = (tmdb_id, watched_at, event_id) => ({ tmdb_id, watched_at, event_id });
const getMovie = async (id) => movie(id);
function user(prefix, timezone = "UTC") { return Number(db.prepare("INSERT INTO users (username,password_hash,timezone) VALUES (?, 'x', ?)").run(`${prefix}_${Date.now()}_${Math.random()}`, timezone).lastInsertRowid); }
function manual(uid, tmdbId, watchedAt) { const row = insertWatch({ userId: uid, movie: movie(tmdbId), watchedAt }); reconcileMovieEligibility(uid, [tmdbId]); return row.id; }
async function pair(prefix, tmdbId) {
  const uid = user(prefix); const canonicalId = manual(uid, tmdbId, "2026-01-10T10:00:00Z");
  applyPreparedAchievementReconciliation(uid, prepareStaticAchievementReconciliation(uid));
  await importHistory(uid, "plex", [event(tmdbId, "2026-01-10T12:00:00Z", `${prefix}-event`)], getMovie, { connectionId: `${prefix}-connection` });
  const duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=? ORDER BY id DESC LIMIT 1").get(uid);
  return { uid, canonicalId, duplicate, candidateId: duplicate.candidate_watch_id };
}
const projection = (id) => db.prepare(`SELECT points,qualifies_for_volume,qualifies_for_achievement,qualifies_for_streak,qualifies_for_season,eligibility_reason,deleted_at,deleted_reason,logical_canonical_watch_id,source,provider_service,provider_connection_id,provider_event_id FROM watches WHERE id=?`).get(id);
let srv, apiUserId, cookie, csrf;
before(async () => {
  srv = await startTestServer();
  const response = await fetch(`${srv.base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `duplicate_api_${process.pid}`, password: "correct-horse-battery" }) });
  const body = await response.json(); assert.equal(response.status, 200); apiUserId = body.user.id; cookie = parseCookies(response).session; csrf = body.csrf_token;
});
after(async () => { if (srv) await srv.close(); });

test("provider candidate is quarantined in its import transaction with no competitive inflation", async () => {
  const f = await pair("pending", 81001); const row = projection(f.candidateId);
  assert.equal(f.duplicate.status, "pending");
  assert.deepEqual([row.points,row.qualifies_for_volume,row.qualifies_for_achievement,row.qualifies_for_streak,row.qualifies_for_season], [0,0,0,0,0]);
  assert.equal(row.eligibility_reason, "duplicate_pending"); assert.equal(totalScore(f.uid), 74);
  assert.deepEqual(db.prepare("SELECT key,revoked_at FROM achievements WHERE user_id=?").all(f.uid), [{ key: "volume:1", revoked_at: null }]);
  const retry = await importHistory(f.uid, "plex", [event(81001, "2026-01-10T12:00:00Z", "pending-event")], getMovie, { connectionId: "pending-connection" });
  assert.equal(retry.skipped, 1); assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE user_id=?").get(f.uid).c, 1);
});

test("all provider events sharing a pending fingerprint remain quarantined", async () => {
  const uid = user("pending_group");
  const canonicalId = manual(uid, 81002, "2026-01-10T10:00:00Z");
  await importHistory(uid, "plex", [
    event(81002, "2026-01-10T08:00:00Z", "pending-group-one"),
    event(81002, "2026-01-10T09:00:00Z", "pending-group-two"),
  ], getMovie, { connectionId: "pending-group" });
  const providerRows = db.prepare("SELECT id FROM watches WHERE user_id=? AND source='plex' ORDER BY watched_at_utc").all(uid);
  assert.equal(providerRows.length, 2);
  for (const row of providerRows) {
    const current = projection(row.id);
    assert.deepEqual(
      [current.points, current.qualifies_for_volume, current.qualifies_for_achievement, current.qualifies_for_streak, current.qualifies_for_season, current.eligibility_reason],
      [0, 0, 0, 0, 0, "duplicate_pending"],
    );
  }
  assert.equal(projection(canonicalId).eligibility_reason, "canonical_first_watch");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE user_id=?").get(uid).c, 2);
});

test("resolving one explicit candidate leaves the other candidate pending", async () => {
  for (const [index, action] of ["merge", "keep_both", "keep_separate"].entries()) {
    const uid = user(`promote_${action}`);
    const tmdbId = 81100 + index;
    manual(uid, tmdbId, "2026-01-11T10:00:00Z");
    await importHistory(uid, "plex", [
      event(tmdbId, "2026-01-11T08:00:00Z", `${action}-one`),
      event(tmdbId, "2026-01-11T09:00:00Z", `${action}-two`),
    ], getMovie, { connectionId: `promote-${action}` });
    const first = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=? AND status='pending'").get(uid);
    await resolveDuplicateCase(uid, first.id, action);
    const resolvedProjection = projection(first.candidate_watch_id);
    if (action === "merge") assert.equal(resolvedProjection.deleted_reason, "duplicate_merged");
    if (action === "keep_both") assert.equal(resolvedProjection.eligibility_reason, "canonical_first_watch");
    if (action === "keep_separate") assert.equal(resolvedProjection.eligibility_reason, "duplicate_keep_separate");
    const pending = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=? AND status='pending'").all(uid);
    assert.equal(pending.length, 1, `${action} must leave the other candidate pending`);
    assert.notEqual(pending[0].candidate_watch_id, first.candidate_watch_id);
    assert.equal(projection(pending[0].candidate_watch_id).eligibility_reason, "duplicate_pending");
    const remainingProviderRows = db.prepare("SELECT id FROM watches WHERE user_id=? AND source='plex' AND deleted_at IS NULL AND id<>?").all(uid, first.candidate_watch_id);
    for (const row of remainingProviderRows) assert.equal(projection(row.id).eligibility_reason, "duplicate_pending");
  }
});

test("duplicate fingerprints reject impossible calendar dates", () => {
  assert.throws(() => duplicateFingerprint(1, "2026-02-30"), /valid calendar day/);
});

test("detection is exact by owner, movie, local day, active manual, and provider source", async () => {
  const uid = user("exact", "America/Chicago"), foreign = user("foreign", "America/Chicago");
  manual(uid, 82001, "2026-02-02T04:00:00Z"); manual(uid, 82002, "2026-02-02T05:00:00Z");
  const deleted = manual(uid, 82003, "2026-02-02T05:00:00Z"); db.prepare("UPDATE watches SET deleted_at='2026-02-03T00:00:00Z',deleted_reason='user_deleted' WHERE id=?").run(deleted);
  manual(foreign, 82004, "2026-02-02T05:00:00Z");
  await importHistory(uid, "plex", [event(82001,"2026-02-02T04:30:00Z","match"),event(82001,"2026-02-02T06:30:00Z","other-day"),event(82002,"2026-02-02T05:30:00Z","movie"),event(82003,"2026-02-02T05:30:00Z","deleted"),event(82004,"2026-02-02T05:30:00Z","foreign")], getMovie, { connectionId: "exact" });
  assert.deepEqual(db.prepare("SELECT fingerprint FROM duplicate_cases WHERE user_id=? ORDER BY fingerprint").all(uid).map(r=>r.fingerprint), ["duplicate-v1:82001:2026-02-01","duplicate-v1:82002:2026-02-01"]);
});

test("closest manual uses absolute UTC delta then ID and snapshots safe evidence", async () => {
  const uid=user("closest"), first=manual(uid,83001,"2026-03-03T09:00:00Z"); manual(uid,83001,"2026-03-03T11:00:00Z");
  await importHistory(uid,"trakt",[event(83001,"2026-03-03T10:00:00Z","closest")],getMovie,{connectionId:"closest"});
  const d=db.prepare("SELECT * FROM duplicate_cases WHERE user_id=?").get(uid); assert.equal(d.canonical_watch_id,first); assert.equal(d.fingerprint,duplicateFingerprint(83001,"2026-03-03"));
  assert.deepEqual(JSON.parse(d.evidence_json), { tmdb_id:83001,watched_day_local:"2026-03-03",canonical:{id:first,source:"manual",watched_at_utc:"2026-03-03T09:00:00.000Z"},candidate:{id:d.candidate_watch_id,source:"trakt",watched_at_utc:"2026-03-03T10:00:00.000Z"},person_ids:[],absolute_delta_ms:3600000 });
});

test("ignore rules are scoped to user and exact movie/day fingerprint", async () => {
  const ignored=user("ignored"), other=user("other"), day="2026-04-04";
  db.prepare("INSERT INTO duplicate_ignore_rules (user_id,fingerprint) VALUES (?,?)").run(ignored,duplicateFingerprint(84001,day));
  manual(ignored,84001,`${day}T08:00:00Z`); manual(ignored,84002,`${day}T08:00:00Z`); manual(other,84001,`${day}T08:00:00Z`);
  await importHistory(ignored,"plex",[event(84001,`${day}T09:00:00Z`,"ignored"),event(84002,`${day}T09:00:00Z`,"film")],getMovie,{connectionId:"ignored"});
  await importHistory(other,"plex",[event(84001,`${day}T09:00:00Z`,"user")],getMovie,{connectionId:"other"});
  assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE user_id=?").get(ignored).c,1); assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE user_id=?").get(other).c,1);
});

test("duplicate resolution remains pending when required dynamic metadata is unavailable", async () => {
  const uid = user("metadata_outage");
  manual(uid, 84501, "2026-04-05T08:00:00Z");
  const collectionMovie = async (id) => movie(id, { belongs_to_collection: { id: 991234, name: "Unavailable Collection" } });
  await importHistory(uid, "plex", [event(84501, "2026-04-05T09:00:00Z", "metadata-outage")], collectionMovie, { connectionId: "metadata-outage" });
  const duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=?").get(uid);
  await assert.rejects(resolveDuplicateCase(uid, duplicate.id, "keep_both"), (error) => error.status === 502);
  assert.deepEqual(
    db.prepare("SELECT status,resolution,resolved_at FROM duplicate_cases WHERE id=?").get(duplicate.id),
    { status: "pending", resolution: null, resolved_at: null },
  );
  assert.equal(projection(duplicate.candidate_watch_id).eligibility_reason, "duplicate_pending");
});

test("merge soft-deletes candidate, links canonical, reverses awards, and preserves provenance", async () => {
  const f=await pair("merge",85001); await resolveDuplicateCase(f.uid,f.duplicate.id,"merge"); const row=projection(f.candidateId);
  assert.ok(row.deleted_at); assert.equal(row.deleted_reason,"duplicate_merged"); assert.equal(row.logical_canonical_watch_id,f.canonicalId); assert.equal(row.points,0);
  assert.deepEqual([row.source,row.provider_service,row.provider_connection_id,row.provider_event_id],["plex","plex","merge-connection","plex:merge-connection:merge-event"]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watches WHERE id=?").get(f.candidateId).c,1); assert.equal(totalScore(f.uid),74);
});

test("keep_both scores normally; keep_separate retains but permanently excludes candidate", async () => {
  const kept=await pair("kept",86001); await resolveDuplicateCase(kept.uid,kept.duplicate.id,"keep_both");
  assert.equal(projection(kept.candidateId).eligibility_reason,"rewatch_cooldown"); assert.deepEqual(db.prepare("SELECT category,points FROM score_events WHERE watch_id=? AND reversed_at IS NULL").get(kept.candidateId),{category:"watch_cooldown",points:0});
  const separate=await pair("separate",86002); await resolveDuplicateCase(separate.uid,separate.duplicate.id,"keep_separate"); const row=projection(separate.candidateId);
  assert.equal(row.deleted_at,null); assert.equal(row.eligibility_reason,"duplicate_keep_separate"); assert.deepEqual([row.points,row.qualifies_for_volume,row.qualifies_for_achievement,row.qualifies_for_streak,row.qualifies_for_season],[0,0,0,0,0]); assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE watch_id=? AND reversed_at IS NULL").get(separate.candidateId).c,0);
});

test("ignore_future_matching keeps current pair and suppresses later exact candidates", async () => {
  const f=await pair("future",87001); await resolveDuplicateCase(f.uid,f.duplicate.id,"ignore_future_matching"); assert.equal(projection(f.candidateId).eligibility_reason,"rewatch_cooldown");
  assert.ok(db.prepare("SELECT 1 FROM duplicate_ignore_rules WHERE user_id=? AND fingerprint=?").get(f.uid,f.duplicate.fingerprint));
  await importHistory(f.uid,"plex",[event(87001,"2026-01-10T13:00:00Z","new")],getMovie,{connectionId:"new"}); assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE user_id=?").get(f.uid).c,1);
});

test("same resolution replay is idempotent; conflicting replay, invalid input, and foreign ownership are rejected", async () => {
  const f=await pair("replay",88001); const first=await resolveDuplicateCase(f.uid,f.duplicate.id,"keep_both"), count=db.prepare("SELECT COUNT(*) c FROM score_events WHERE user_id=?").get(f.uid).c;
  assert.deepEqual(await resolveDuplicateCase(f.uid,f.duplicate.id,"keep_both"),first); assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE user_id=?").get(f.uid).c,count);
  await assert.rejects(resolveDuplicateCase(f.uid,f.duplicate.id,"merge"),e=>e.status===409); await assert.rejects(resolveDuplicateCase(user("owner"),f.duplicate.id,"merge"),e=>e.status===404); await assert.rejects(resolveDuplicateCase(f.uid,0,"merge"),e=>e.status===400); await assert.rejects(resolveDuplicateCase(f.uid,f.duplicate.id,"bad"),e=>e.status===400);
});

test("forced reconciliation failure rolls back case, watch, ledger, and achievement state", async () => {
  const f=await pair("rollback",89001), before=projection(f.candidateId), achievements=db.prepare("SELECT * FROM achievements WHERE user_id=?").all(f.uid);
  db.exec(`CREATE TRIGGER fail_duplicate BEFORE INSERT ON score_events WHEN NEW.watch_id=${f.candidateId} BEGIN SELECT RAISE(ABORT,'forced duplicate rollback'); END;`);
  try { await assert.rejects(resolveDuplicateCase(f.uid,f.duplicate.id,"keep_both"),/forced duplicate rollback/); } finally { db.exec("DROP TRIGGER fail_duplicate"); }
  assert.deepEqual(db.prepare("SELECT status,resolution,resolved_at FROM duplicate_cases WHERE id=?").get(f.duplicate.id),{status:"pending",resolution:null,resolved_at:null}); assert.deepEqual(projection(f.candidateId),before); assert.deepEqual(db.prepare("SELECT * FROM achievements WHERE user_id=?").all(f.uid),achievements);
  assert.equal((await resolveDuplicateCase(f.uid,f.duplicate.id,"keep_both")).status,"resolved");
});

test("deleting a pending canonical reassigns or cancels with an audit reason", async () => {
  const f = await pair("delete_canonical", 89501);
  await deleteWatchAndReconcileAchievements(f.uid, f.canonicalId);
  let duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE id=?").get(f.duplicate.id);
  assert.deepEqual([duplicate.status, duplicate.resolution, duplicate.cancellation_reason], ["resolved", "keep_both", "canonical_watch_deleted"]);
  assert.equal(projection(f.candidateId).eligibility_reason, "canonical_first_watch");

  const uid = user("delete_reassign");
  const first = manual(uid, 89502, "2026-01-10T09:00:00Z");
  const second = manual(uid, 89502, "2026-01-10T11:00:00Z");
  await importHistory(uid, "plex", [event(89502, "2026-01-10T09:30:00Z", "delete-reassign")], getMovie, { connectionId: "delete-reassign" });
  duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=?").get(uid);
  assert.equal(duplicate.canonical_watch_id, first);
  await deleteWatchAndReconcileAchievements(uid, first);
  duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE id=?").get(duplicate.id);
  assert.deepEqual([duplicate.status, duplicate.canonical_watch_id, duplicate.cancellation_reason], ["pending", second, null]);
  assert.equal(projection(duplicate.candidate_watch_id).eligibility_reason, "duplicate_pending");
});

test("deleting a pending candidate closes the review without changing delete provenance", async () => {
  const f = await pair("delete_candidate", 89503);
  await deleteWatchAndReconcileAchievements(f.uid, f.candidateId);
  const duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE id=?").get(f.duplicate.id);
  assert.deepEqual([duplicate.status, duplicate.resolution, duplicate.cancellation_reason], ["resolved", "merge", "candidate_watch_deleted"]);
  assert.equal(projection(f.candidateId).deleted_reason, "user_deleted");
  await assert.rejects(resolveDuplicateCase(f.uid, f.duplicate.id, "merge"), (error) => error.status === 409);
});

test("timezone changes rebase, split, and coalesce explicit duplicate cases safely", async () => {
  const split = user("timezone_split");
  manual(split, 89601, "2026-01-10T01:00:00Z");
  await importHistory(split, "plex", [event(89601, "2026-01-10T23:00:00Z", "timezone-split")], getMovie, { connectionId: "timezone-split" });
  const splitCase = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=?").get(split);
  await updateUserSettings(split, { timezone: "America/Chicago" });
  const splitAfter = db.prepare("SELECT * FROM duplicate_cases WHERE id=?").get(splitCase.id);
  assert.deepEqual([splitAfter.status, splitAfter.resolution, splitAfter.cancellation_reason], ["resolved", "keep_both", "timezone_no_matching_manual"]);
  assert.equal(projection(splitAfter.candidate_watch_id).eligibility_reason, "rewatch_cooldown");

  const joined = user("timezone_joined");
  manual(joined, 89602, "2026-01-10T22:00:00Z");
  manual(joined, 89602, "2026-01-11T01:00:00Z");
  await importHistory(joined, "plex", [
    event(89602, "2026-01-10T23:00:00Z", "timezone-join-one"),
    event(89602, "2026-01-11T00:30:00Z", "timezone-join-two"),
  ], getMovie, { connectionId: "timezone-joined" });
  await updateUserSettings(joined, { timezone: "America/Chicago" });
  const joinedCases = db.prepare("SELECT fingerprint,status FROM duplicate_cases WHERE user_id=? ORDER BY id").all(joined);
  assert.deepEqual(joinedCases, [
    { fingerprint: "duplicate-v1:89602:2026-01-10", status: "pending" },
    { fingerprint: "duplicate-v1:89602:2026-01-10", status: "pending" },
  ]);
});

test("timezone changes move scoped ignore rules to the candidate local day", async () => {
  const uid = user("timezone_ignore");
  manual(uid, 89603, "2026-01-10T01:00:00Z");
  await importHistory(uid, "plex", [event(89603, "2026-01-10T02:00:00Z", "timezone-ignore")], getMovie, { connectionId: "timezone-ignore" });
  const duplicate = db.prepare("SELECT * FROM duplicate_cases WHERE user_id=?").get(uid);
  await resolveDuplicateCase(uid, duplicate.id, "ignore_future_matching");
  const oldFingerprint = duplicate.fingerprint;
  await updateUserSettings(uid, { timezone: "America/Chicago" });
  const current = db.prepare("SELECT fingerprint FROM duplicate_cases WHERE id=?").get(duplicate.id).fingerprint;
  assert.equal(current, "duplicate-v1:89603:2026-01-09");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_ignore_rules WHERE user_id=? AND fingerprint=?").get(uid, current).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_ignore_rules WHERE user_id=? AND fingerprint=?").get(uid, oldFingerprint).c, 0);
});

test("API validates, scopes ownership, and emits safe joined DTOs", async () => {
  const canonical=manual(apiUserId,90001,"2026-05-05T10:00:00Z"); await importHistory(apiUserId,"plex",[event(90001,"2026-05-05T11:00:00Z","api")],getMovie,{connectionId:"api-secret"}); const d=db.prepare("SELECT * FROM duplicate_cases WHERE user_id=? ORDER BY id DESC").get(apiUserId);
  let response=await fetch(`${srv.base}/api/duplicates?status=pending`,{headers:{Cookie:`session=${cookie}`}}); assert.equal(response.status,200); const body=await response.json(); assert.equal(body.duplicates[0].canonical_watch.id,canonical); assert.equal(body.duplicates[0].candidate_watch.id,d.candidate_watch_id); assert.equal(body.duplicates[0].candidate_watch.provider_connection_id,undefined); assert.equal(body.duplicates[0].evidence.absolute_delta_ms,3600000);
  response=await fetch(`${srv.base}/api/duplicates?status=bad`,{headers:{Cookie:`session=${cookie}`}}); assert.equal(response.status,400);
  response=await fetch(`${srv.base}/api/duplicates/${d.id}/resolve`,{method:"POST",headers:{Cookie:`session=${cookie}`,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({action:"bad"})}); assert.equal(response.status,400);
  const foreign=await pair("api_foreign",90002); response=await fetch(`${srv.base}/api/duplicates/${foreign.duplicate.id}/resolve`,{method:"POST",headers:{Cookie:`session=${cookie}`,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({action:"merge"})}); assert.equal(response.status,404); assert.equal(getDuplicateCases(apiUserId,"resolved").length,0);
});
