process.env.DATA_DIR = `/tmp/rs-leaderboards-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test } from "node:test";
import assert from "node:assert/strict";
const { db } = await import("../src/db.js");
const { awardScoreEvent } = await import("../src/repositories/score-ledger.js");
const { createLeague, createInvite, acceptInvite, leaveLeague } = await import("../src/services/league-service.js");
const { listLeaderboard } = await import("../src/services/leaderboard-service.js");

let sequence = 0;
function user(name = "lb-user") {
  sequence += 1;
  return Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'hash','user')")
    .run(`${name}-${sequence}`).lastInsertRowid);
}
function inviteToken(invite) { return decodeURIComponent(invite.invite_path.slice("/join#invite=".length)); }
function leagueWithMembers(count = 3) {
  const ownerId = user("owner");
  const league = createLeague(ownerId, { name: `Leaderboard ${sequence}`, timezone: "UTC", default_mode: "casual" });
  const invite = createInvite(ownerId, league.id, { expires_at: "2099-01-01T00:00:00.000Z", max_uses: 10 });
  const members = [ownerId];
  for (let i = 1; i < count; i += 1) {
    const memberId = user("member");
    acceptInvite(memberId, inviteToken(invite));
    members.push(memberId);
  }
  return { ownerId, league, members };
}
function event(userId, key, points, effectiveAt, { seasonId = null, seasonMemberId = null } = {}) {
  return awardScoreEvent({
    eventKey: key, userId, seasonId, seasonMemberId, category: "test", points,
    ruleVersion: "test-v1", metadata: {}, createdAt: effectiveAt, effectiveAt,
  });
}
function ids(entries) { return entries.map((entry) => [entry.rank, entry.user_id, entry.points]); }

test("lifetime leaderboard is private to active league members, includes zero rows, and ranks ties by competition rank", () => {
  const { ownerId, league, members } = leagueWithMembers(4);
  const outsider = user("outsider");
  event(members[0], "life-owner-a", 10, "2030-01-01T00:00:00.000Z");
  event(members[0], "life-owner-b", 5, "2030-01-02T00:00:00.000Z");
  event(members[1], "life-member-a", 15, "2030-01-03T00:00:00.000Z");
  event(members[2], "life-member-b", 1, "2030-01-04T00:00:00.000Z");
  event(outsider, "life-outsider", 999, "2030-01-05T00:00:00.000Z");

  const board = listLeaderboard(ownerId, league.id, { scope: "lifetime" });
  assert.equal(board.scope, "lifetime");
  assert.equal(board.entries.length, 4);
  assert.deepEqual(ids(board.entries), [[1, members[1], 15], [1, members[0], 15], [3, members[2], 1], [4, members[3], 0]]);
  assert.throws(() => listLeaderboard(outsider, league.id, { scope: "lifetime" }), (error) => error?.status === 404);
});

test("weekly and monthly leaderboards use league-local effective-time windows and exclude season projections", () => {
  const { ownerId, league, members } = leagueWithMembers(3);
  event(members[0], "week-before", 50, "2030-01-05T23:59:59.000Z");
  event(members[0], "week-start", 7, "2030-01-07T00:00:00.000Z");
  event(members[1], "week-mid", 9, "2030-01-10T12:00:00.000Z");
  event(members[1], "month-out", 99, "2030-02-01T00:00:00.000Z");

  const weekly = listLeaderboard(ownerId, league.id, { scope: "weekly", weekStart: "2030-01-07" });
  assert.deepEqual({ starts_at: weekly.starts_at, ends_at: weekly.ends_at }, { starts_at: "2030-01-07T00:00:00.000Z", ends_at: "2030-01-14T00:00:00.000Z" });
  assert.deepEqual(ids(weekly.entries), [[1, members[1], 9], [2, members[0], 7], [3, members[2], 0]]);

  const monthly = listLeaderboard(ownerId, league.id, { scope: "monthly", month: "2030-01" });
  assert.deepEqual({ starts_at: monthly.starts_at, ends_at: monthly.ends_at }, { starts_at: "2030-01-01T00:00:00.000Z", ends_at: "2030-02-01T00:00:00.000Z" });
  assert.deepEqual(ids(monthly.entries), [[1, members[0], 57], [2, members[1], 9], [3, members[2], 0]]);
});

test("season leaderboard uses participant snapshots, not current membership, and remains readable after departure", () => {
  const ownerId = user("season-owner"), departedId = user("departed-member");
  const leagueId = Number(db.prepare(`INSERT INTO leagues(name,timezone,default_mode,owner_user_id,created_by_user_id,created_at,updated_at)
    VALUES ('Snapshot League','UTC','casual',?,?,?,?)`).run(ownerId, ownerId, "2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z").lastInsertRowid);
  const ownerMembership = Number(db.prepare(`INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at)
    VALUES (?,?,'member',?,?)`).run(leagueId, ownerId, "2029-01-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z").lastInsertRowid);
  const departedMembership = Number(db.prepare(`INSERT INTO league_memberships(league_id,user_id,role,joined_at,left_at,created_at)
    VALUES (?,?,'member',?,?,?)`).run(leagueId, departedId, "2029-01-01T00:00:00.000Z", "2030-03-15T00:00:00.000Z", "2029-01-01T00:00:00.000Z").lastInsertRowid);
  const seasonId = Number(db.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(leagueId, "Season", "casual", "UTC", "season-v1", "2030-03-01T00:00:00.000Z", "2030-04-01T00:00:00.000Z", ownerId).lastInsertRowid);
  const ownerSeasonMemberId = Number(db.prepare(`INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) VALUES (?,?,?,?,?)`)
    .run(seasonId, ownerMembership, ownerId, "owner snapshot", "2030-03-01T00:00:00.000Z").lastInsertRowid);
  const departedSeasonMemberId = Number(db.prepare(`INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from,eligible_until) VALUES (?,?,?,?,?,?)`)
    .run(seasonId, departedMembership, departedId, "departed snapshot", "2030-03-01T00:00:00.000Z", "2030-03-15T00:00:00.000Z").lastInsertRowid);
  db.prepare("UPDATE seasons SET participants_locked_at=? WHERE id=?").run("2030-03-01T00:00:00.000Z", seasonId);
  event(ownerId, "season-owner", 20, "2030-03-02T00:00:00.000Z", { seasonId, seasonMemberId: ownerSeasonMemberId });
  event(departedId, "season-member", 30, "2030-03-03T00:00:00.000Z", { seasonId, seasonMemberId: departedSeasonMemberId });

  const board = listLeaderboard(ownerId, leagueId, { scope: "season", seasonId });
  assert.equal(board.scope, "season");
  assert.equal(board.season_id, seasonId);
  assert.deepEqual(ids(board.entries), [[1, departedId, 30], [2, ownerId, 20]]);
  assert.equal(board.entries[0].username, "departed snapshot");
});

test("leaderboard input rejects ambiguous periods and mismatched private seasons", () => {
  const { ownerId, league } = leagueWithMembers(1);
  const otherOwner = user("other-owner");
  const other = createLeague(otherOwner, { name: "Other League", timezone: "UTC", default_mode: "casual" });
  const otherSeasonId = Number(db.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(other.id, "Other", "casual", "UTC", "season-v1", "2030-01-01T00:00:00.000Z", "2030-02-01T00:00:00.000Z", otherOwner).lastInsertRowid);
  assert.throws(() => listLeaderboard(ownerId, league.id, { scope: "weekly", weekStart: "2030-01-08" }), (error) => error?.status === 400 && /Monday/i.test(error.message));
  assert.throws(() => listLeaderboard(ownerId, league.id, { scope: "monthly", month: "2030-1" }), (error) => error?.status === 400);
  assert.throws(() => listLeaderboard(ownerId, league.id, { scope: "season", seasonId: otherSeasonId }), (error) => error?.status === 404);
});


test("HTTP leaderboard routes enforce auth, strict IDs, and private season scope", async () => {
  const { createServer } = await import("node:http");
  const { createSession } = await import("../src/auth.js");
  const { createApp } = await import("../src/index.js");
  const { ownerId, league, members } = leagueWithMembers(2);
  event(members[1], "http-life", 42, "2031-01-01T00:00:00.000Z");
  const session = createSession(ownerId, { ip: "127.0.0.1" });
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/leagues/${league.id}/leaderboards/lifetime`);
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/leagues/01/leaderboards/lifetime`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/leagues/${league.id}/leaderboards/lifetime?extra=1`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/leagues/${league.id}/leaderboards/lifetime?seasonId=1`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/leagues/${league.id}/leaderboards/lifetime`, { headers: { Cookie: `session=${session.token}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(ids(body.leaderboard.entries), [[1, members[1], 42], [2, ownerId, 0]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
