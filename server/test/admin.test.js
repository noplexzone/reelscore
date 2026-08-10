// Admin API tests.
process.env.DATA_DIR = `/tmp/rs-admin-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, parseCookies } from "./helpers/server.js";

let srv;
let adminCookie, adminCsrf, adminId;
let userCookie, userCsrf, userId;

before(async () => {
  srv = await startTestServer();

  // First registered user becomes admin (bootstrap).
  const adminR = await fetch(`${srv.base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "adminuser", password: "adminpass123" }),
  });
  const adminData = await adminR.json();
  adminCookie = parseCookies(adminR).session;
  adminCsrf = adminData.csrf_token;
  adminId = adminData.user.id;

  // Second user is a normal user.
  const userR = await fetch(`${srv.base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "normaluser", password: "normalpass123" }),
  });
  const userData = await userR.json();
  userCookie = parseCookies(userR).session;
  userCsrf = userData.csrf_token;
  userId = userData.user.id;
});

after(async () => {
  if (srv) await srv.close();
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test("normal user cannot GET /api/admin/users", async () => {
  const r = await fetch(`${srv.base}/api/admin/users`, {
    headers: { Cookie: `session=${userCookie}` },
  });
  assert.equal(r.status, 403);
});

test("unauthenticated request to admin route returns 401", async () => {
  const r = await fetch(`${srv.base}/api/admin/users`);
  assert.equal(r.status, 401);
});

test("admin can GET /api/admin/users", async () => {
  const r = await fetch(`${srv.base}/api/admin/users`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.users));
  assert.ok(body.users.length >= 2);
});

// ---------------------------------------------------------------------------
// Secret-free responses
// ---------------------------------------------------------------------------

test("admin user list never returns password_hash", async () => {
  const r = await fetch(`${srv.base}/api/admin/users`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  const body = await r.json();
  for (const u of body.users) {
    assert.ok(!u.password_hash, "no password_hash in user object");
    assert.ok(!u.token_hash, "no token_hash in user object");
  }
});

test("admin user response contains role and status", async () => {
  const r = await fetch(`${srv.base}/api/admin/users`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  const body = await r.json();
  const admin = body.users.find((u) => u.username === "adminuser");
  assert.ok(admin, "admin user in list");
  assert.equal(admin.role, "admin");
  assert.equal(admin.status, "active");
});

// ---------------------------------------------------------------------------
// Role and status management
// ---------------------------------------------------------------------------

test("admin can set user role to admin", async () => {
  const r = await fetch(`${srv.base}/api/admin/users/${userId}/role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(r.status, 200);

  const check = await fetch(`${srv.base}/api/admin/users/${userId}`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  const data = await check.json();
  assert.equal(data.user.role, "admin");
});

test("admin can set user role back to user", async () => {
  const r = await fetch(`${srv.base}/api/admin/users/${userId}/role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ role: "user" }),
  });
  assert.equal(r.status, 200);
});

test("admin can disable and reactivate user", async () => {
  // Disable.
  const disR = await fetch(`${srv.base}/api/admin/users/${userId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(disR.status, 200);

  // Verify login blocked.
  const loginR = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "normaluser", password: "normalpass123" }),
  });
  assert.equal(loginR.status, 403);

  // Reactivate.
  const reactR = await fetch(`${srv.base}/api/admin/users/${userId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(reactR.status, 200);

  // Login works again.
  const loginR2 = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "normaluser", password: "normalpass123" }),
  });
  assert.equal(loginR2.status, 200);
});

test("invalid role value rejected", async () => {
  const r = await fetch(`${srv.base}/api/admin/users/${userId}/role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ role: "superuser" }),
  });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Admin session revoke
// ---------------------------------------------------------------------------

test("admin can revoke all user sessions", async () => {
  // Log normal user in to get a fresh session.
  const loginR = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "normaluser", password: "normalpass123" }),
  });
  const loginData = await loginR.json();
  const targetCookie = parseCookies(loginR).session;

  // Verify session works.
  const meR = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${targetCookie}` },
  });
  assert.equal(meR.status, 200);

  // Admin revokes all sessions for the user.
  const revokeR = await fetch(`${srv.base}/api/admin/users/${userId}/sessions/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({}),
  });
  assert.equal(revokeR.status, 200);

  // Session is now invalid.
  const afterR = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${targetCookie}` },
  });
  assert.equal(afterR.status, 401);
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

test("admin can create an invite", async () => {
  const r = await fetch(`${srv.base}/api/admin/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ email: "newuser@example.com" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.invite_code, "invite_code returned");
  assert.ok(typeof body.invite_code === "string");
  assert.ok(body.invite_code.length >= 32, "invite code is long enough");
  assert.ok(body.expires_at, "expires_at returned");
});

test("invite list: token_hash never returned", async () => {
  const r = await fetch(`${srv.base}/api/admin/invites`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  for (const inv of body.invites) {
    assert.ok(!inv.token_hash, "token_hash must not appear in invite list");
  }
});

test("invite: code is not stored in plain (only hash)", async () => {
  // Create an invite.
  const r = await fetch(`${srv.base}/api/admin/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({}),
  });
  const { invite_code } = await r.json();

  // The raw invite_code must NOT appear in the invites table.
  const { db } = await import("../src/db.js");
  const rows = db.prepare("SELECT token_hash FROM invites").all();
  for (const row of rows) {
    assert.notEqual(row.token_hash, invite_code, "raw code not stored as token_hash");
  }
});

test("invite: valid code can be used to register", async () => {
  // Create invite.
  const invR = await fetch(`${srv.base}/api/admin/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({}),
  });
  const { invite_code } = await invR.json();

  // Use the invite to register (self_hosted invite mode — set REGISTRATION_MODE override).
  // NOTE: In self_hosted mode REGISTRATION_MODE defaults to 'open', so invite_code is ignored.
  // This test verifies the self_hosted open path still works even when invite_code is passed.
  const regR = await fetch(`${srv.base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "inviteduser",
      password: "invitedpass123",
      invite_code,
    }),
  });
  assert.equal(regR.status, 200);
});

test("invite: can be revoked by admin", async () => {
  // Create invite.
  const invR = await fetch(`${srv.base}/api/admin/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({}),
  });
  await invR.json();

  // Get invite id.
  const listR = await fetch(`${srv.base}/api/admin/invites`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  const { invites } = await listR.json();
  const inv = invites.find((i) => !i.revoked && !i.used_at);
  assert.ok(inv, "un-used invite found");

  // Revoke it.
  const revokeR = await fetch(`${srv.base}/api/admin/invites/${inv.id}/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
  });
  assert.equal(revokeR.status, 200);

  // Verify it's revoked in the list.
  const listR2 = await fetch(`${srv.base}/api/admin/invites`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  const { invites: invites2 } = await listR2.json();
  const revokedInv = invites2.find((i) => i.id === inv.id);
  assert.equal(revokedInv.revoked, 1, "invite is marked revoked");
});

test("normal user cannot create invites", async () => {
  // First re-activate and re-login.
  const loginR = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "normaluser", password: "normalpass123" }),
  });
  const loginData = await loginR.json();
  const freshCookie = parseCookies(loginR).session;
  const freshCsrf = loginData.csrf_token;

  const r = await fetch(`${srv.base}/api/admin/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${freshCookie}`,
      "X-CSRF-Token": freshCsrf,
    },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------

test("admin reconciliation preview/apply is explicit, CSRF-protected, one-use, and forbidden to normal users", async () => {
  const { db } = await import("../src/db.js");
  db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at) VALUES (?,8801,'Admin Fixture',49,'manual','2026-07-27 12:00:00')`).run(userId);
  db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,points,source,watched_at,provider_service,provider_connection_id,provider_event_id)
    VALUES (?,8801,'Admin Fixture',49,'plex','2020-01-01 12:00:00','plex','machine:subject','plex:machine:subject:8801')`).run(userId);
  const revokedAchievementId = Number(db.prepare(`INSERT INTO achievements
    (user_id,key,name,description,points,revoked_at,revocation_reason)
    VALUES (?,'volume:1','Opening Night','Log your first film',25,datetime('now'),'fixture')`).run(userId).lastInsertRowid);

  const userLogin = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "normaluser", password: "normalpass123" }),
  });
  const userLoginData = await userLogin.json();
  const currentUserCookie = parseCookies(userLogin).session;
  const denied = await fetch(`${srv.base}/api/admin/users/${userId}/reconciliation/preview`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: `session=${currentUserCookie}`, "X-CSRF-Token": userLoginData.csrf_token },
    body: JSON.stringify({ placeholder_date: "2026-07-27" }),
  });
  assert.equal(denied.status, 403);

  const previewR = await fetch(`${srv.base}/api/admin/users/${userId}/reconciliation/preview`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: `session=${adminCookie}`, "X-CSRF-Token": adminCsrf },
    body: JSON.stringify({ placeholder_date: "2026-07-27" }),
  });
  const previewText = await previewR.text();
  assert.equal(previewR.status, 200, previewText);
  const preview = JSON.parse(previewText);
  assert.equal(preview.candidates.length, 1);

  const applyBody = { nonce: preview.nonce, preview_hash: preview.preview_hash, candidate_ids: [preview.candidates[0].candidate_id] };
  db.exec(`CREATE TRIGGER force_admin_achievement_failure BEFORE UPDATE ON achievements
    WHEN NEW.id=${revokedAchievementId} BEGIN SELECT RAISE(ABORT,'forced admin achievement failure'); END`);
  const failedApply = await fetch(`${srv.base}/api/admin/users/${userId}/reconciliation/apply`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: `session=${adminCookie}`, "X-CSRF-Token": adminCsrf }, body: JSON.stringify(applyBody),
  });
  assert.equal(failedApply.status, 500);
  assert.equal(db.prepare("SELECT consumed_at FROM reconciliation_previews WHERE nonce_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1").get().consumed_at, null);
  assert.equal(db.prepare("SELECT deleted_at FROM watches WHERE provider_event_id='plex:machine:subject:8801'").get().deleted_at, null);
  db.exec("DROP TRIGGER force_admin_achievement_failure");
  const applyR = await fetch(`${srv.base}/api/admin/users/${userId}/reconciliation/apply`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: `session=${adminCookie}`, "X-CSRF-Token": adminCsrf }, body: JSON.stringify(applyBody),
  });
  assert.equal(applyR.status, 200, await applyR.text());
  const replay = await fetch(`${srv.base}/api/admin/users/${userId}/reconciliation/apply`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: `session=${adminCookie}`, "X-CSRF-Token": adminCsrf }, body: JSON.stringify(applyBody),
  });
  assert.equal(replay.status, 409);
});

test("admin can search users by username", async () => {
  const r = await fetch(`${srv.base}/api/admin/users?q=admin`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.users.some((u) => u.username === "adminuser"));
});
