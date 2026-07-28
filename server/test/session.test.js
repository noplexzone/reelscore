// Cookie-based session and CSRF tests.
process.env.DATA_DIR = `/tmp/rs-session-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, parseCookies, rawSetCookies, cookieHas } from "./helpers/server.js";

let srv;
let adminCookie, adminCsrf;
let db, createSession;

before(async () => {
  srv = await startTestServer();
  ({ db } = await import("../src/db.js"));
  ({ createSession } = await import("../src/auth.js"));

  // Register the first user (becomes admin after migration bootstrap).
  const r = await fetch(`${srv.base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "testadmin", password: "adminpass123" }),
  });
  const d = await r.json();
  assert.equal(r.status, 200, "register succeeds");
  const cookies = parseCookies(r);
  adminCookie = cookies.session;
  adminCsrf = d.csrf_token;
});

after(async () => {
  if (srv) await srv.close();
});

// ---------------------------------------------------------------------------
// Register / Login cookies
// ---------------------------------------------------------------------------

test("login: returns Set-Cookie with session token", async () => {
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "testadmin", password: "adminpass123" }),
  });
  assert.equal(r.status, 200);
  const setCookies = rawSetCookies(r);
  assert.ok(setCookies.length > 0, "at least one Set-Cookie header");
  const sessionCookieStr = setCookies.find((c) => c.startsWith("session="));
  assert.ok(sessionCookieStr, "session cookie present");
  assert.ok(cookieHas(sessionCookieStr, "httponly"), "HttpOnly flag set");
  assert.ok(cookieHas(sessionCookieStr, "samesite=lax"), "SameSite=Lax set");
  assert.ok(cookieHas(sessionCookieStr, "path=/"), "Path=/ set");
});

test("login: response body contains csrf_token and user (no JWT)", async () => {
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "testadmin", password: "adminpass123" }),
  });
  const body = await r.json();
  assert.ok(body.csrf_token, "csrf_token present");
  assert.ok(body.user, "user object present");
  assert.ok(!body.token, "no JWT token field");
  assert.ok(!body.jwt, "no jwt field");
  assert.equal(typeof body.csrf_token, "string");
  assert.ok(body.csrf_token.length >= 32, "csrf_token is long enough");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("session cap keeps only the ten newest active sessions", () => {
  const id = Number(db.prepare("INSERT INTO users (username,password_hash) VALUES ('sessioncap','hash')").run().lastInsertRowid);
  for (let i = 0; i < 12; i++) createSession(id, { ip: `192.0.2.${i + 1}` });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?").get(id).c, 10);
});

test("idle sessions expire after seven days", async () => {
  const id = Number(db.prepare("INSERT INTO users (username,password_hash) VALUES ('idleuser','hash')").run().lastInsertRowid);
  const session = createSession(id);
  db.prepare("UPDATE sessions SET last_seen_at=datetime('now','-8 days') WHERE user_id=?").run(id);
  const response = await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${session.token}` } });
  assert.equal(response.status, 401);
});

test("login: self_hosted cookie is NOT Secure (HTTP LAN safe)", async () => {
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "testadmin", password: "adminpass123" }),
  });
  const setCookies = rawSetCookies(r);
  const sessionCookieStr = setCookies.find((c) => c.startsWith("session="));
  // In self_hosted mode, cookie should NOT have Secure flag.
  assert.ok(!cookieHas(sessionCookieStr, ";secure"), "no Secure flag in self_hosted mode");
});

test("login: wrong password returns 401", async () => {
  const r = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "testadmin", password: "wrongpassword" }),
  });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------------------
// Session auth for protected routes
// ---------------------------------------------------------------------------

test("requireAuth: no cookie returns 401", async () => {
  const r = await fetch(`${srv.base}/api/me`);
  assert.equal(r.status, 401);
});

test("requireAuth: valid session cookie grants access", async () => {
  const r = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.username, "testadmin");
});

test("requireAuth: unknown session cookie returns 401", async () => {
  const r = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: "session=deadbeefdeadbeef000000000000000000000000000000000000000000000000" },
  });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------------------
// CSRF protection
// ---------------------------------------------------------------------------

test("CSRF: POST without X-CSRF-Token returns 403", async () => {
  const r = await fetch(`${srv.base}/api/me/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
    },
    body: JSON.stringify({ public_profile: true }),
  });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.ok(/csrf/i.test(body.error));
});

test("CSRF: POST with wrong X-CSRF-Token returns 403", async () => {
  const r = await fetch(`${srv.base}/api/me/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": "wrong-csrf-token",
    },
    body: JSON.stringify({ public_profile: true }),
  });
  assert.equal(r.status, 403);
});

test("CSRF: POST with correct X-CSRF-Token succeeds", async () => {
  const r = await fetch(`${srv.base}/api/me/settings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ public_profile: true }),
  });
  assert.equal(r.status, 200);
});

test("CSRF: GET requests do not require CSRF token", async () => {
  const r = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test("logout: invalidates session immediately", async () => {
  // Create a new session for this test.
  const loginR = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "testadmin", password: "adminpass123" }),
  });
  const loginData = await loginR.json();
  const cookies = parseCookies(loginR);
  const token = cookies.session;
  const csrf = loginData.csrf_token;

  // Verify it works.
  const beforeR = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${token}` },
  });
  assert.equal(beforeR.status, 200);

  // Logout.
  const logoutR = await fetch(`${srv.base}/api/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${token}`,
      "X-CSRF-Token": csrf,
    },
  });
  assert.equal(logoutR.status, 200);

  // Session is now invalid.
  const afterR = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${token}` },
  });
  assert.equal(afterR.status, 401);
});

test("logout requires authentication and CSRF", async () => {
  const unauthenticated = await fetch(`${srv.base}/api/auth/logout`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  const missingCsrf = await fetch(`${srv.base}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(missingCsrf.status, 403);
});

// ---------------------------------------------------------------------------
// Disabled user
// ---------------------------------------------------------------------------

test("disabled user: login returns 403", async () => {
  // Register a second user, then disable them.
  const regR = await fetch(`${srv.base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "victim", password: "victimpass123" }),
  });
  assert.equal(regR.status, 200);
  const regData = await regR.json();
  const victimId = regData.user.id;
  const victimCsrf = regData.csrf_token;
  const victimCookie = parseCookies(regR).session;

  // Admin disables the user.
  const disableR = await fetch(`${srv.base}/api/admin/users/${victimId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${adminCookie}`,
      "X-CSRF-Token": adminCsrf,
    },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(disableR.status, 200);

  // Victim's existing session should now be revoked (sessions deleted on disable).
  const victimMeR = await fetch(`${srv.base}/api/me`, {
    headers: { Cookie: `session=${victimCookie}` },
  });
  assert.ok(victimMeR.status === 401 || victimMeR.status === 403);

  // Victim cannot log in.
  const loginR = await fetch(`${srv.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "victim", password: "victimpass123" }),
  });
  assert.equal(loginR.status, 403);
});

// ---------------------------------------------------------------------------
// /auth/me — session hydration endpoint
// ---------------------------------------------------------------------------

test("/auth/me: returns user and csrf_token for valid session", async () => {
  const r = await fetch(`${srv.base}/api/auth/me`, {
    headers: { Cookie: `session=${adminCookie}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.csrf_token, "csrf_token in /auth/me");
  assert.ok(body.user, "user in /auth/me");
  assert.equal(body.user.username, "testadmin");
});

test("/auth/me: returns 401 without session", async () => {
  const r = await fetch(`${srv.base}/api/auth/me`);
  assert.equal(r.status, 401);
});
