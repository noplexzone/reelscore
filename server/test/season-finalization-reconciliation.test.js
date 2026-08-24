process.env.DATA_DIR = `/tmp/rs-season-finalization-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";
import test from "node:test";
import assert from "node:assert/strict";

const { db } = await import("../src/db.js");
const { createLeague, createInvite, acceptInvite, archiveLeague } = await import("../src/services/league-service.js");
const { finalizeSeason } = await import("../src/services/season-service.js");
const { logManualWatchAndReconcile } = await import("../src/services/manual-watch-service.js");
const { createSession } = await import("../src/auth.js");
const { createApp } = await import("../src/index.js");
const { createServer } = await import("node:http");

let seq = 0;
function user(name = "u") {
  seq += 1;
  return Number(db.prepare("INSERT INTO users(username,password_hash,timezone) VALUES (?,'x','UTC')").run(`${name}-${process.pid}-${seq}`).lastInsertRowid);
}
function leagueWithMember() {
  const owner = user("owner");
  const member = user("member");
  const league = createLeague(owner, { name: `League ${seq}`, timezone: "UTC", default_mode: "casual" });
  const invite = createInvite(owner, league.id, { expires_at: "2036-01-01T00:00:00.000Z", max_uses: 1 });
  acceptInvite(member, decodeURIComponent(invite.invite_path.slice("/join#invite=".length)));
  return { owner, member, league };
}
function historicalLeagueWithMember() {
  const owner = user("hist-owner");
  const member = user("hist-member");
  const leagueId = Number(db.prepare("INSERT INTO leagues(name,timezone,default_mode,owner_user_id,created_by_user_id,created_at,updated_at) VALUES (?,'UTC','casual',?,?,?,?)")
    .run(`Historical ${seq}`, owner, owner, "2019-01-01T00:00:00.000Z", "2019-01-01T00:00:00.000Z").lastInsertRowid);
  db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
    .run(leagueId, owner, "member", "2019-01-01T00:00:00.000Z", "2019-01-01T00:00:00.000Z", leagueId, member, "member", "2019-01-01T00:00:00.000Z", "2019-01-01T00:00:00.000Z");
  return { owner, member, league: { id: leagueId } };
}
function addSeasonMember(seasonId, leagueId, participant, starts) {
  const membership = db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? ORDER BY id DESC LIMIT 1").get(leagueId, participant).id;
  db.prepare("INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from,created_at) VALUES (?,?,?,?,?,?)")
    .run(seasonId, membership, participant, `u${participant}`, starts, starts);
}
function insertLockedSeason(owner, league, { starts = "2098-01-01T00:00:00.000Z", ends = "2098-02-01T00:00:00.000Z", participant = owner, participants = null } = {}) {
  const id = Number(db.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id,created_at,updated_at)
    VALUES (?,?, 'casual','UTC','season-v1',?,?,?,?,?)`).run(league.id, `Season ${seq}`, starts, ends, owner, starts, starts).lastInsertRowid);
  for (const memberId of (participants ?? [participant])) addSeasonMember(id, league.id, memberId, starts);
  db.prepare("UPDATE seasons SET participants_locked_at=?,updated_at=? WHERE id=?").run(starts, starts, id);
  return { id, starts, ends };
}
function insertWatchAndSource(userId, { tmdb = 9001, source = "manual", watchedAt, receivedAt = watchedAt, provider = false } = {}) {
  const watchId = Number(db.prepare(`INSERT INTO watches(user_id,tmdb_id,title,points,is_rewatch,source,watched_at,watched_at_utc,watched_day_local,timezone_used,qualifies_for_season,provider_service,provider_connection_id,provider_event_id)
    VALUES (?,?,?,10,0,?,?,?,?,?,1,?,?,?)`).run(
      userId, tmdb, `Movie ${tmdb}`, source, watchedAt.replace("T", " ").slice(0, 19), watchedAt, watchedAt.slice(0, 10), "UTC",
      provider ? source : null, provider ? "acct" : null, provider ? `${source}:${tmdb}:${seq}` : null,
    ).lastInsertRowid);
  const eventId = Number(db.prepare(`INSERT INTO score_events(event_key,user_id,watch_id,category,points,rule_version,metadata_json,created_at,effective_at)
    VALUES (?,?,?,?,10,'season-v1','{}',?,?)`).run(`watch/${watchId}/manual/${seq}`, userId, watchId, "watch_first", receivedAt, watchedAt).lastInsertRowid);
  return { watchId, eventId };
}
function seasonRoots(seasonId) {
  return db.prepare("SELECT * FROM score_events WHERE season_id=? AND projection_source_event_id IS NOT NULL AND reverses_event_id IS NULL ORDER BY id").all(seasonId);
}
function activeSeasonRoots(seasonId) {
  return db.prepare("SELECT * FROM score_events WHERE season_id=? AND projection_source_event_id IS NOT NULL AND reverses_event_id IS NULL AND reversed_at IS NULL ORDER BY id").all(seasonId);
}
async function withServer(fn) {
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
const headersFor = (userId) => {
  const session = createSession(userId, { ip: "127.0.0.1" });
  return { Cookie: `session=${session.token}`, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
};

test("finalizeSeason reconciles all participant projections in one transaction before freezing", () => {
  const { owner, member, league } = leagueWithMember();
  const season = insertLockedSeason(owner, league, { participant: member });
  const source = insertWatchAndSource(member, { watchedAt: "2098-01-10T12:00:00.000Z" });
  assert.equal(seasonRoots(season.id).length, 0);
  const finalized = finalizeSeason(owner, season.id, { asOf: "2098-02-04T00:00:00.000Z" });
  assert.equal(finalized.status, "finalized");
  assert.equal(seasonRoots(season.id)[0].projection_source_event_id, source.eventId);
  insertWatchAndSource(member, { tmdb: 9002, watchedAt: "2098-01-11T12:00:00.000Z" });
  assert.equal(finalizeSeason(owner, season.id, { asOf: "2098-02-05T00:00:00.000Z" }).finalized_at, finalized.finalized_at);
  assert.deepEqual(seasonRoots(season.id).map((row) => row.projection_source_event_id), [source.eventId]);
});

test("finalization rolls back projections when a later participant cannot reconcile", () => {
  const { owner, member, league } = leagueWithMember();
  const season = insertLockedSeason(owner, league, { participants: [owner, member] });
  insertWatchAndSource(owner, { tmdb: 9051, watchedAt: "2098-01-10T12:00:00.000Z" });
  insertWatchAndSource(member, { tmdb: 9052, watchedAt: "2098-01-11T12:00:00.000Z" });
  db.exec(`CREATE TEMP TRIGGER fail_member_projection BEFORE INSERT ON score_events
    WHEN NEW.season_id=${season.id} AND NEW.user_id=${member}
    BEGIN SELECT RAISE(ABORT,'forced member projection failure'); END;`);
  assert.throws(() => finalizeSeason(owner, season.id, { asOf: "2098-02-04T00:00:00.000Z" }), /reconcile/i);
  assert.equal(db.prepare("SELECT finalized_at FROM seasons WHERE id=?").get(season.id).finalized_at, null);
  assert.equal(seasonRoots(season.id).length, 0);
  db.exec("DROP TRIGGER fail_member_projection");
});

test("post-end real manual log uses receipt time rather than watched time for finalization grace", async () => {
  const { owner, member, league } = historicalLeagueWithMember();
  const season = insertLockedSeason(owner, league, { starts: "2020-01-01T00:00:00.000Z", ends: "2021-01-01T00:00:00.000Z", participant: member });
  await logManualWatchAndReconcile(member, { id: 9201, title: "Late manual", genres: [], credits: {} }, { watchedAt: "2020-06-01T12:00:00.000Z" });
  finalizeSeason(owner, season.id, { asOf: "2021-01-04T00:00:00.000Z" });
  assert.equal(activeSeasonRoots(season.id).length, 0);
});

test("post-end reconciliation excludes new manual receipts but accepts provider attestations before the 72h deadline", () => {
  const { owner, member, league } = leagueWithMember();
  const season = insertLockedSeason(owner, league, { participant: member });
  insertWatchAndSource(member, { tmdb: 9101, watchedAt: "2098-01-10T12:00:00.000Z", receivedAt: "2098-02-01T12:00:00.000Z" });
  const provider = insertWatchAndSource(member, { tmdb: 9102, source: "plex", provider: true, watchedAt: "2098-01-11T12:00:00.000Z", receivedAt: "2098-02-03T23:59:59.000Z" });
  insertWatchAndSource(member, { tmdb: 9103, source: "trakt", provider: true, watchedAt: "2098-01-12T12:00:00.000Z", receivedAt: "2098-02-04T00:00:00.000Z" });
  const legacyLateManual = insertWatchAndSource(member, { tmdb: 9104, watchedAt: "2098-01-13T12:00:00.000Z", receivedAt: "2098-02-01 12:00:00" });
  const duplicatePeer = insertWatchAndSource(member, { tmdb: 9104, watchedAt: "2098-02-02T12:05:00.000Z", receivedAt: "2098-01-31T23:00:00.000Z" });
  db.prepare("INSERT INTO duplicate_cases(user_id,fingerprint,canonical_watch_id,candidate_watch_id,status,resolution,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(member, `late-manual-${seq}`, duplicatePeer.watchId, legacyLateManual.watchId, "resolved", "keep_both", "2098-01-31T23:00:00.000Z", "2098-02-01T01:00:00.000Z");
  finalizeSeason(owner, season.id, { asOf: "2098-02-04T00:00:00.000Z" });
  assert.deepEqual(seasonRoots(season.id).map((row) => row.projection_source_event_id), [provider.eventId]);
});

test("manager reconcile route is bounded, authenticated, audited, and does not leak or mutate frozen seasons", async () => {
  const { owner, member, league } = historicalLeagueWithMember();
  const outsider = user("outsider");
  const season = insertLockedSeason(owner, league, { starts: "2020-01-01T00:00:00.000Z", ends: "2030-01-01T00:00:00.000Z", participant: member });
  insertWatchAndSource(member, { watchedAt: "2025-01-10T12:00:00.000Z" });
  await withServer(async (base) => {
    let r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: "null" });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({ afterUserId: null }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({ limit: 101 }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({ limit: 1, extra: true }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(outsider), body: JSON.stringify({ limit: 1 }) });
    assert.equal(r.status, 404);
    r = await fetch(`${base}/api/leagues/01/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({}) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({ limit: 1 }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.reconciliation.processed, 1);
    assert.equal(body.reconciliation.done, true);
    assert.equal(seasonRoots(season.id).length, 1);
    const audit = db.prepare("SELECT user_id,action,target_id,detail FROM audit_log WHERE action='season.reconcile' ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.user_id, owner);
    assert.equal(audit.target_id, season.id);
    assert.deepEqual(Object.keys(JSON.parse(audit.detail)).sort(), ["after_user_id", "done", "failed", "limit", "next_cursor", "processed", "season_id"]);
    const scheduled = insertLockedSeason(owner, league, { starts: "2098-03-01T00:00:00.000Z", ends: "2098-04-01T00:00:00.000Z", participant: member });
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${scheduled.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({}) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reconciliation.ready, false);
    finalizeSeason(owner, season.id, { asOf: "2030-01-04T00:00:00.000Z" });
    r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({}) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reconciliation.frozen, true);
  });
});

test("manager reconcile route rejects archived leagues without mutating or auditing", async () => {
  const owner = user("archive-owner");
  const league = createLeague(owner, { name: `Archived ${seq}`, timezone: "UTC", default_mode: "casual" });
  const season = insertLockedSeason(owner, league);
  archiveLeague(owner, league.id);
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/leagues/${league.id}/seasons/${season.id}/reconcile`, { method: "POST", headers: headersFor(owner), body: JSON.stringify({}) });
    assert.equal(r.status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='season.reconcile' AND target_id=?").get(season.id).c, 0);
  });
});
