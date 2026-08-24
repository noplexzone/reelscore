process.env.DATA_DIR = `/tmp/rs-leagues-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test } from "node:test";
import assert from "node:assert/strict";
const { db } = await import("../src/db.js");
const {
  createLeague, listLeagues, getLeague, createInvite, inspectInvite, acceptInvite,
  revokeInvite, leaveLeague, setMemberRole, transferOwnership, archiveLeague, leagueInviteDigest,
} = await import("../src/services/league-service.js");

let sequence = 0;
function user(role = "user") {
  sequence += 1;
  return Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'hash',?)")
    .run(`league-user-${sequence}`, role).lastInsertRowid);
}
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const status = (code, pattern = /.*/) => (error) => error?.status === code && pattern.test(error.message);
function safe(value) {
  const text = JSON.stringify(value);
  for (const key of ["token_hash", "password_hash", "email_normalized", "mfa_secret"]) assert.equal(text.includes(key), false, `${key} leaked`);
}
function inviteToken(invite) {
  assert.match(invite.invite_path, /^\/join#invite=[A-Za-z0-9_-]+$/);
  return decodeURIComponent(invite.invite_path.slice("/join#invite=".length));
}
function fixture() {
  const ownerId = user(), memberId = user();
  const league = createLeague(ownerId, { name: `Private ${sequence}`, timezone: "America/New_York", default_mode: "verified" });
  const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 5 });
  acceptInvite(memberId, inviteToken(invite));
  return { ownerId, memberId, league };
}

test("createLeague atomically creates a member-stored owner episode and derives owner role", () => {
  const ownerId = user();
  const league = createLeague(ownerId, { name: "  Film Club  ", timezone: "UTC", default_mode: "casual" });
  assert.equal(league.name, "Film Club"); assert.equal(league.role, "owner"); assert.equal(league.owner_user_id, ownerId);
  const membership = db.prepare("SELECT * FROM league_memberships WHERE league_id=? AND user_id=?").get(league.id, ownerId);
  assert.equal(membership.role, "member"); assert.equal(membership.left_at, null);
  assert.match(membership.joined_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); safe(league);
});

test("createLeague transaction rolls back the league when owner membership fails", () => {
  const ownerId = user();
  db.exec("CREATE TEMP TRIGGER fail_owner_membership BEFORE INSERT ON league_memberships BEGIN SELECT RAISE(ABORT,'injected membership failure'); END");
  try { assert.throws(() => createLeague(ownerId, { name: "Must Roll Back", timezone: "UTC", default_mode: "casual" }), /injected membership failure/); }
  finally { db.exec("DROP TRIGGER fail_owner_membership"); }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM leagues WHERE name='Must Roll Back'").get().count, 0);
});

test("list/read are private to active members and global admins receive no override", () => {
  const ownerId = user(), globalAdminId = user("admin"), outsiderId = user();
  const league = createLeague(ownerId, { name: "Invisible League", timezone: "UTC", default_mode: "challenge" });
  assert.deepEqual(listLeagues(globalAdminId), []); assert.deepEqual(listLeagues(outsiderId), []);
  assert.throws(() => getLeague(globalAdminId, league.id), status(404, /not found/i));
  assert.equal(listLeagues(ownerId)[0].role, "owner");
  const detail = getLeague(ownerId, league.id); assert.equal(detail.members[0].role, "owner"); safe(detail);
});

test("owner/admin/member matrix governs invites and owner-only operations", () => {
  const { ownerId, memberId, league } = fixture(); const outsiderAdminId = user("admin");
  assert.throws(() => createInvite(memberId, league.id, { expires_at: future(), max_uses: 1 }), status(403));
  assert.throws(() => createInvite(outsiderAdminId, league.id, { expires_at: future(), max_uses: 1 }), status(404));
  setMemberRole(ownerId, league.id, memberId, "admin");
  const invite = createInvite(memberId, league.id, { expires_at: future(), max_uses: 2 });
  assert.equal(invite.role, "member"); revokeInvite(memberId, invite.id);
  assert.throws(() => setMemberRole(memberId, league.id, ownerId, "member"), status(403));
  assert.throws(() => archiveLeague(memberId, league.id), status(403));
});

test("invite plaintext is shown once; only a keyed digest persists; DTOs are safe", () => {
  const ownerId = user();
  const league = createLeague(ownerId, { name: "Digest League", timezone: "Europe/London", default_mode: "casual" });
  const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 3 });
  const stored = db.prepare("SELECT * FROM league_invites WHERE id=?").get(invite.id);
  assert.equal(inviteToken(invite).length, 43); assert.equal(stored.token_hash, leagueInviteDigest(inviteToken(invite)));
  assert.notEqual(stored.token_hash, inviteToken(invite)); assert.equal(JSON.stringify(stored).includes(inviteToken(invite)), false);
  assert.deepEqual(inspectInvite(inviteToken(invite)), { league_name: "Digest League", expires_at: invite.expires_at });
  safe(invite); safe(inspectInvite(inviteToken(invite)));
});

test("accept is replay-safe, capacity-bound, and rejoin creates a new episode", () => {
  const ownerId = user(), firstId = user(), secondId = user();
  const league = createLeague(ownerId, { name: "Capacity", timezone: "UTC", default_mode: "casual" });
  const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 1 });
  assert.equal(acceptInvite(firstId, inviteToken(invite)).role, "member"); assert.equal(acceptInvite(firstId, inviteToken(invite)).id, league.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM league_invite_uses WHERE invite_id=?").get(invite.id).c, 1);
  const generic = status(400, /^Invite is invalid or unavailable\.$/);
  assert.throws(() => acceptInvite(secondId, inviteToken(invite)), generic); assert.throws(() => inspectInvite(inviteToken(invite)), generic);
  leaveLeague(firstId, league.id);
  acceptInvite(firstId, inviteToken(invite));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM league_invite_uses WHERE invite_id=?").get(invite.id).c, 1);
  const episodes = db.prepare("SELECT id,left_at FROM league_memberships WHERE league_id=? AND user_id=? ORDER BY id").all(league.id, firstId);
  assert.equal(episodes.length, 2); assert.ok(episodes[0].left_at); assert.equal(episodes[1].left_at, null);
});

test("distinct users cannot overrun invite capacity under concurrent processes", async () => {
  const { spawn } = await import("node:child_process");
  const ownerId = user(), firstId = user(), secondId = user();
  const league = createLeague(ownerId, { name: "Concurrent Capacity", timezone: "UTC", default_mode: "casual" });
  const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 1 });
  const childSource = `
    let token = "";
    for await (const chunk of process.stdin) token += chunk;
    const { acceptInvite } = await import("./src/services/league-service.js");
    try { acceptInvite(Number(process.argv[1]), token); process.exit(0); }
    catch (error) { if (error?.status === 400) process.exit(2); throw error; }
  `;
  const run = (id) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, String(id)], {
      cwd: process.cwd(), env: process.env, stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(inviteToken(invite));
  });
  const results = await Promise.all([run(firstId), run(secondId)]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 2], results.map((result) => result.stderr).join("\n"));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM league_invite_uses WHERE invite_id=?").get(invite.id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM league_memberships WHERE league_id=? AND user_id IN (?,?)").get(league.id, firstId, secondId).c, 1);
});

test("accept transaction rolls membership back when invite-use insertion fails", () => {
  const ownerId = user(), memberId = user();
  const league = createLeague(ownerId, { name: "Accept Rollback", timezone: "UTC", default_mode: "casual" });
  const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 1 });
  db.exec("CREATE TEMP TRIGGER fail_invite_use BEFORE INSERT ON league_invite_uses BEGIN SELECT RAISE(ABORT,'injected invite-use failure'); END");
  try { assert.throws(() => acceptInvite(memberId, inviteToken(invite)), /injected invite-use failure/); }
  finally { db.exec("DROP TRIGGER fail_invite_use"); }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM league_memberships WHERE league_id=? AND user_id=?").get(league.id, memberId).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM league_invite_uses WHERE invite_id=?").get(invite.id).c, 0);
});

test("unknown, malformed, expired and revoked invites share one generic failure", () => {
  const ownerId = user(), joinerId = user();
  const league = createLeague(ownerId, { name: "Generic", timezone: "UTC", default_mode: "casual" });
  const generic = status(400, /^Invite is invalid or unavailable\.$/);
  for (const token of ["unknown-token-that-is-long-enough-to-digest", "short", "", null]) {
    assert.throws(() => inspectInvite(token), generic); assert.throws(() => acceptInvite(joinerId, token), generic);
  }
  const expired = "expired-token-that-is-long-enough-for-digest";
  db.prepare("INSERT INTO league_invites(league_id,created_by_user_id,token_hash,max_uses,expires_at,created_at) VALUES (?,?,?,?,?,?)")
    .run(league.id, ownerId, leagueInviteDigest(expired), 1, "2020-01-02T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  assert.throws(() => inspectInvite(expired), generic); assert.throws(() => acceptInvite(joinerId, expired), generic);
  const revoked = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 1 }); revokeInvite(ownerId, revoked.id);
  assert.throws(() => inspectInvite(inviteToken(revoked)), generic); assert.throws(() => acceptInvite(joinerId, inviteToken(revoked)), generic);
  assert.deepEqual(revokeInvite(ownerId, revoked.id), revokeInvite(ownerId, revoked.id));
});

test("invite revocation does not reveal records from inaccessible private leagues", () => {
  const ownerId = user(), outsiderId = user();
  const league = createLeague(ownerId, { name: "No Oracle", timezone: "UTC", default_mode: "casual" });
  const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 1 });
  let missing, inaccessible;
  try { revokeInvite(outsiderId, invite.id + 999999); } catch (error) { missing = error; }
  try { revokeInvite(outsiderId, invite.id); } catch (error) { inaccessible = error; }
  assert.deepEqual({ status: inaccessible.status, message: inaccessible.message }, { status: missing.status, message: missing.message });
});

test("leaving closes only the active episode, is idempotent, and protects owner", () => {
  const { ownerId, memberId, league } = fixture();
  const createdAt = new Date().toISOString();
  const scoreId = Number(db.prepare(`INSERT INTO score_events(event_key,user_id,category,points,rule_version,metadata_json,created_at,effective_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(`leave-score/${league.id}/${memberId}`, memberId, "adjustment", 17, "test-v1", "{}", createdAt, createdAt).lastInsertRowid);
  assert.equal(leaveLeague(memberId, league.id).left, true);
  assert.deepEqual(db.prepare("SELECT id,points FROM score_events WHERE id=?").get(scoreId), { id: scoreId, points: 17 });
  const episode = db.prepare("SELECT * FROM league_memberships WHERE league_id=? AND user_id=?").get(league.id, memberId);
  assert.ok(episode.left_at > episode.joined_at); assert.equal(leaveLeague(memberId, league.id).left, false);
  assert.throws(() => leaveLeague(ownerId, league.id), status(409, /transfer ownership/i));
});

test("mid-season departure atomically freezes the participant cutoff before closing membership", () => {
  const { ownerId, memberId, league } = fixture();
  const membership = db.prepare("SELECT id,joined_at FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(league.id, memberId);
  const startsAt = new Date(new Date(membership.joined_at).getTime() + 1).toISOString();
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  const seasonId = Number(db.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(league.id, "Current", "verified", "UTC", "season-v1", startsAt, endsAt, ownerId).lastInsertRowid);
  db.prepare(`INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from)
    VALUES (?,?,?,?,?)`).run(seasonId, membership.id, memberId, "member-snapshot", startsAt);
  db.prepare("UPDATE seasons SET participants_locked_at=? WHERE id=?").run(startsAt, seasonId);
  const departure = leaveLeague(memberId, league.id);
  assert.equal(db.prepare("SELECT eligible_until FROM season_members WHERE season_id=? AND membership_id=?").get(seasonId, membership.id).eligible_until, departure.left_at);
  assert.equal(db.prepare("SELECT left_at FROM league_memberships WHERE id=?").get(membership.id).left_at, departure.left_at);
});

test("only owner changes roles and transfers ownership without replacing target episode", () => {
  const { ownerId, memberId, league } = fixture();
  const membershipId = db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(league.id, memberId).id;
  assert.equal(setMemberRole(ownerId, league.id, memberId, "admin").role, "admin");
  assert.equal(setMemberRole(ownerId, league.id, memberId, "member").role, "member");
  assert.throws(() => setMemberRole(ownerId, league.id, ownerId, "admin"), status(409, /owner/i));
  assert.throws(() => setMemberRole(ownerId, league.id, memberId, "owner"), status(400));
  const transferred = transferOwnership(ownerId, league.id, memberId);
  assert.equal(transferred.owner_user_id, memberId); assert.equal(transferred.role, "member");
  assert.equal(db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(league.id, memberId).id, membershipId);
  assert.equal(getLeague(memberId, league.id).role, "owner"); assert.equal(getLeague(ownerId, league.id).role, "member");
  assert.throws(() => transferOwnership(ownerId, league.id, ownerId), status(403)); assert.equal(leaveLeague(ownerId, league.id).left, true);
});

test("archive is owner-only, idempotent, remains visible and blocks new invites", () => {
  const { ownerId, memberId, league } = fixture(); assert.throws(() => archiveLeague(memberId, league.id), status(403));
  const archived = archiveLeague(ownerId, league.id); assert.ok(archived.archived_at);
  assert.deepEqual(archiveLeague(ownerId, league.id), archived);
  assert.equal(getLeague(memberId, league.id).archived_at, archived.archived_at);
  assert.throws(() => createInvite(ownerId, league.id, { expires_at: future(), max_uses: 1 }), status(409, /archived/i));
});

test("strictly validates IDs, objects, bounded strings, timezone, mode, expiry, capacity and roles", () => {
  const userId = user(); const valid = { name: "Valid", timezone: "UTC", default_mode: "casual" };
  for (const id of ["1", 0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createLeague(id, valid), status(400));
  for (const input of [null, [], {}, { ...valid, name: " " }, { ...valid, name: "x".repeat(101) }, { ...valid, timezone: "Not/A_Zone" }, { ...valid, timezone: `UTC${" ".repeat(64)}` }, { ...valid, default_mode: "ranked" }]) assert.throws(() => createLeague(userId, input), status(400));
  const league = createLeague(userId, valid);
  for (const input of [null, [], {}, { expires_at: "bad", max_uses: 1 }, { expires_at: new Date(Date.now()-1000).toISOString(), max_uses: 1 }, { expires_at: future(), max_uses: 0 }, { expires_at: future(), max_uses: 1001 }, { expires_at: future(), max_uses: 1.5 }, { expires_at: future(), max_uses: "1" }]) assert.throws(() => createInvite(userId, league.id, input), status(400));
  assert.throws(() => getLeague(userId, "1"), status(400)); assert.throws(() => revokeInvite(userId, 1.1), status(400));
  assert.throws(() => setMemberRole(userId, league.id, userId, "owner"), status(400));
});


test("HTTP routes enforce auth, CSRF, private reads, strict IDs, and no-store public invite preview", async () => {
  const { createServer } = await import("node:http");
  const { createSession } = await import("../src/auth.js");
  const { createApp } = await import("../src/index.js");
  const ownerId = user(), outsiderId = user();
  const ownerSession = createSession(ownerId, { ip: "127.0.0.1" });
  const outsiderSession = createSession(outsiderId, { ip: "127.0.0.1" });
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = { Cookie: `session=${ownerSession.token}` };
  try {
    let response = await fetch(`${base}/api/leagues`);
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/leagues`, {
      method: "POST", headers: { ...ownerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HTTP League", timezone: "UTC", default_mode: "challenge" }),
    });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/leagues`, {
      method: "POST", headers: { ...ownerHeaders, "X-CSRF-Token": ownerSession.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HTTP League", timezone: "UTC", default_mode: "challenge" }),
    });
    assert.equal(response.status, 201);
    const league = (await response.json()).league;
    response = await fetch(`${base}/api/leagues/${league.id}`, { headers: { Cookie: `session=${outsiderSession.token}` } });
    assert.equal(response.status, 404);
    for (const invalidId of ["not-an-id", "01", "+1", "1e0"]) {
      response = await fetch(`${base}/api/leagues/${invalidId}`, { headers: ownerHeaders });
      assert.equal(response.status, 400);
    }

    const invite = createInvite(ownerId, league.id, { expires_at: future(), max_uses: 2 });
    response = await fetch(`${base}/api/league-invites/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken(invite) }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    const preview = (await response.json()).invite;
    assert.deepEqual(preview, { league_name: "HTTP League", expires_at: invite.expires_at });
    assert.equal(JSON.stringify(preview).includes(inviteToken(invite)), false);
    response = await fetch(`${base}/api/league-invites/preview/${inviteToken(invite)}`);
    assert.equal(response.status, 401);

    response = await fetch(`${base}/api/leagues/invites/accept`, {
      method: "POST",
      headers: { Cookie: `session=${outsiderSession.token}`, "X-CSRF-Token": outsiderSession.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken(invite) }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).league.id, league.id);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
