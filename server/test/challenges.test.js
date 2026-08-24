process.env.DATA_DIR = `/tmp/rs-challenges-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test } from "node:test";
import assert from "node:assert/strict";
const { db } = await import("../src/db.js");
const { createLeague, createInvite, acceptInvite, archiveLeague } = await import("../src/services/league-service.js");
const { listLeaderboard } = await import("../src/services/leaderboard-service.js");
const { createChallengeDefinition, listChallengeDefinitions, assignChallenge, completeChallenge, getChallengeDashboard } = await import("../src/services/challenge-service.js");

let sequence = 0;
function user(name = "challenge-user") {
  sequence += 1;
  return Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'hash','user')")
    .run(`${name}-${sequence}`).lastInsertRowid);
}
function inviteToken(invite) { return decodeURIComponent(invite.invite_path.slice("/join#invite=".length)); }
function fixture({ mode = "challenge", locked = true } = {}) {
  const ownerId = user("owner"), memberId = user("member"), outsiderId = user("outsider");
  const league = createLeague(ownerId, { name: `Challenges ${sequence}`, timezone: "UTC", default_mode: "challenge" });
  const invite = createInvite(ownerId, league.id, { expires_at: "2099-01-01T00:00:00.000Z", max_uses: 5 });
  acceptInvite(memberId, inviteToken(invite));
  const ownerMembership = db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(league.id, ownerId).id;
  const memberMembership = db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(league.id, memberId).id;
  const seasonId = Number(db.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(league.id, "Challenge Season", mode, "UTC", "season-v1", "2030-01-01T00:00:00.000Z", "2030-02-01T00:00:00.000Z", ownerId).lastInsertRowid);
  const ownerSeasonMemberId = Number(db.prepare(`INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (?,?,?,?,?)`)
    .run(seasonId, ownerMembership, ownerId, "owner snapshot", "2030-01-01T00:00:00.000Z").lastInsertRowid);
  const memberSeasonMemberId = Number(db.prepare(`INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (?,?,?,?,?)`)
    .run(seasonId, memberMembership, memberId, "member snapshot", "2030-01-01T00:00:00.000Z").lastInsertRowid);
  if (locked) db.prepare("UPDATE seasons SET participants_locked_at=? WHERE id=?").run("2030-01-01T00:00:00.000Z", seasonId);
  return { ownerId, memberId, outsiderId, league, seasonId, ownerSeasonMemberId, memberSeasonMemberId };
}
const status = (code, pattern = /.*/) => (error) => error?.status === code && pattern.test(error.message);
function safe(value) {
  const text = JSON.stringify(value);
  for (const key of ["score_event_id", "season_member_id", "membership_id", "password_hash", "token_hash", "metadata_json"]) assert.equal(text.includes(key), false, `${key} leaked`);
}

test("managers create and members list safe league challenge definitions", () => {
  const { ownerId, memberId, outsiderId, league } = fixture();
  const def = createChallengeDefinition(ownerId, league.id, { slug: "watch-noir", title: "Watch Noir", description: "A noir film", points: 25, rule_version: "challenge-v1" });
  assert.equal(def.slug, "watch-noir"); assert.equal(def.points, 25); safe(def);
  assert.deepEqual(listChallengeDefinitions(memberId, league.id).map((row) => row.id), [def.id]);
  assert.throws(() => listChallengeDefinitions(outsiderId, league.id), status(404));
  assert.throws(() => createChallengeDefinition(memberId, league.id, { slug: "bad", title: "Bad", points: 1, rule_version: "challenge-v1" }), status(403));
  assert.throws(() => createChallengeDefinition(ownerId, league.id, { slug: "bad space", title: "Bad", points: 1, rule_version: "challenge-v1" }), status(400));
  assert.throws(() => createChallengeDefinition(ownerId, league.id, { slug: "watch-noir", title: "Dupe", points: 1, rule_version: "challenge-v1" }), /UNIQUE|constraint/i);
});

test("challenge assignment is manager-only, participant-scoped, idempotent, and requires locked challenge seasons", () => {
  const { ownerId, memberId, outsiderId, league, seasonId } = fixture();
  const def = createChallengeDefinition(ownerId, league.id, { slug: "weekly-pick", title: "Weekly Pick", points: 10, rule_version: "challenge-v1" });
  const assigned = assignChallenge(ownerId, league.id, seasonId, { challenge_definition_id: def.id, user_id: memberId });
  assert.equal(assigned.status, "pending"); assert.equal(assigned.user_id, memberId); safe(assigned);
  assert.equal(assignChallenge(ownerId, league.id, seasonId, { challenge_definition_id: def.id, user_id: memberId }).id, assigned.id);
  assert.throws(() => assignChallenge(memberId, league.id, seasonId, { challenge_definition_id: def.id, user_id: ownerId }), status(403));
  assert.throws(() => assignChallenge(ownerId, league.id, seasonId, { challenge_definition_id: def.id, user_id: outsiderId }), status(404, /participant/i));
  const casual = fixture({ mode: "casual" });
  const casualDef = createChallengeDefinition(casual.ownerId, casual.league.id, { slug: "casual", title: "Casual", points: 10, rule_version: "challenge-v1" });
  assert.throws(() => assignChallenge(casual.ownerId, casual.league.id, casual.seasonId, { challenge_definition_id: casualDef.id, user_id: casual.memberId }), status(409, /challenge-mode/i));
  const unlocked = fixture({ locked: false });
  const unlockedDef = createChallengeDefinition(unlocked.ownerId, unlocked.league.id, { slug: "unlocked", title: "Unlocked", points: 10, rule_version: "challenge-v1" });
  assert.throws(() => assignChallenge(unlocked.ownerId, unlocked.league.id, unlocked.seasonId, { challenge_definition_id: unlockedDef.id, user_id: unlocked.memberId }), status(409, /locked/i));
});

test("completion awards one immutable season bonus and dashboard exposes safe progress", () => {
  const { ownerId, memberId, league, seasonId } = fixture();
  const def = createChallengeDefinition(ownerId, league.id, { slug: "bonus", title: "Bonus", description: null, points: 33, rule_version: "challenge-v1" });
  const assigned = assignChallenge(ownerId, league.id, seasonId, { challenge_definition_id: def.id, user_id: memberId });
  db.prepare("UPDATE challenge_definitions SET points=99,rule_version='changed-v1',title='Changed' WHERE id=?").run(def.id);
  const completed = completeChallenge(ownerId, league.id, seasonId, assigned.id, { evidence_note: "approved" });
  assert.equal(completed.status, "completed"); assert.equal(completed.completed_at !== null, true); safe(completed);
  assert.equal(completed.points, 33); assert.equal(completed.rule_version, undefined);
  assert.equal(completed.title, "Bonus");
  assert.equal(completeChallenge(ownerId, league.id, seasonId, assigned.id, {}).id, assigned.id);
  const event = db.prepare("SELECT * FROM score_events WHERE event_key=?").get(`season/${seasonId}/challenge-assignment/${assigned.id}`);
  assert.equal(event.points, 33); assert.equal(event.rule_version, "challenge-v1"); assert.equal(event.category, "challenge_bonus"); assert.equal(event.user_id, memberId);
  assert.deepEqual(listLeaderboard(ownerId, league.id, { scope: "season", seasonId }).entries.map((row) => [row.user_id, row.points]), [[memberId, 33], [ownerId, 0]]);
  const dashboard = getChallengeDashboard(ownerId, league.id, seasonId);
  assert.deepEqual(dashboard.totals, { assigned: 1, completed: 1, pending: 0 }); safe(dashboard);
});

test("frozen or archived seasons reject assignment and completion without extra events", () => {
  const { ownerId, memberId, league, seasonId } = fixture();
  const def = createChallengeDefinition(ownerId, league.id, { slug: "freeze", title: "Freeze", points: 11, rule_version: "challenge-v1" });
  const assigned = assignChallenge(ownerId, league.id, seasonId, { challenge_definition_id: def.id, user_id: memberId });
  db.prepare("UPDATE seasons SET finalized_at=?,updated_at=? WHERE id=?").run("2030-02-05T00:00:00.000Z", "2030-02-05T00:00:00.000Z", seasonId);
  assert.throws(() => completeChallenge(ownerId, league.id, seasonId, assigned.id, {}), status(409, /Frozen/i));
  assert.throws(() => db.prepare("UPDATE challenge_assignments SET status='cancelled',cancelled_at=? WHERE id=?").run("2030-02-06T00:00:00.000Z", assigned.id), /frozen/i);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE event_key=?").get(`season/${seasonId}/challenge-assignment/${assigned.id}`).c, 0);
  const archived = fixture();
  const archivedDef = createChallengeDefinition(archived.ownerId, archived.league.id, { slug: "archive", title: "Archive", points: 10, rule_version: "challenge-v1" });
  archiveLeague(archived.ownerId, archived.league.id);
  assert.throws(() => assignChallenge(archived.ownerId, archived.league.id, archived.seasonId, { challenge_definition_id: archivedDef.id, user_id: archived.memberId }), status(409, /Archived/i));
});

test("HTTP challenge routes enforce auth, CSRF, strict IDs, and safe bodies", async () => {
  const { createServer } = await import("node:http");
  const { createSession } = await import("../src/auth.js");
  const { createApp } = await import("../src/index.js");
  const { ownerId, memberId, league, seasonId } = fixture();
  const session = createSession(ownerId, { ip: "127.0.0.1" });
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Cookie: `session=${session.token}`, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
  try {
    let response = await fetch(`${base}/api/leagues/${league.id}/challenges`);
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/leagues/01/challenges`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/leagues/${league.id}/challenges`, { method: "POST", headers: { Cookie: `session=${session.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ slug: "http", title: "HTTP", points: 5, rule_version: "challenge-v1" }) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/leagues/${league.id}/challenges`, { method: "POST", headers: auth, body: JSON.stringify({ slug: "http", title: "HTTP", points: 5, rule_version: "challenge-v1", extra: true }) });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/leagues/${league.id}/challenges`, { method: "POST", headers: auth, body: JSON.stringify({ slug: "http", title: "HTTP", points: 5, rule_version: "challenge-v1" }) });
    assert.equal(response.status, 201);
    const def = (await response.json()).challenge;
    response = await fetch(`${base}/api/leagues/${league.id}/seasons/${seasonId}/challenges/assign`, { method: "POST", headers: auth, body: JSON.stringify({ challenge_definition_id: def.id, user_id: memberId }) });
    assert.equal(response.status, 201);
    const assignment = (await response.json()).assignment;
    response = await fetch(`${base}/api/leagues/${league.id}/seasons/${seasonId}/challenge-assignments/${assignment.id}/complete`, { method: "POST", headers: auth, body: JSON.stringify({ evidence_note: "ok" }) });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/leagues/${league.id}/seasons/${seasonId}/challenge-dashboard`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(response.status, 200);
    safe(await response.json());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
