// Tests requireAuth and requireCsrf middleware with cookie-based sessions.
// MUST set DATA_DIR before any db.js import — use dynamic imports for isolation.
process.env.DATA_DIR = `/tmp/rs-auth-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import { test } from "node:test";
import assert from "node:assert/strict";

// Dynamic imports so DATA_DIR is resolved before db.js evaluates.
const { db } = await import("../src/db.js");
const { requireAuth, requireCsrf, createSession, sha256 } = await import(
  "../src/auth.js"
);

function mockRes() {
  let capturedStatus = null;
  let capturedBody = null;
  const res = {
    status(s) {
      capturedStatus = s;
      return { json(b) { capturedBody = b; } };
    },
    clearCookie() {},
    get _status() { return capturedStatus; },
    get _body() { return capturedBody; },
  };
  return res;
}

// Insert a unique test user and create a session.
const userId = db
  .prepare("INSERT INTO users (username, password_hash) VALUES ('authtest', 'hash')")
  .run().lastInsertRowid;

const { token, csrfToken } = createSession(userId, { ip: "127.0.0.1" });

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

test("requireAuth: rejects request with no session cookie", () => {
  const req = { cookies: {} };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.ok(/sign in/i.test(res._body.error));
  assert.equal(called, false);
});

test("requireAuth: rejects unknown session token (not in DB)", () => {
  const req = { cookies: { session: "deadbeef".repeat(8) } };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.equal(called, false);
});

test("requireAuth: rejects forged token (wrong hash)", () => {
  const req = { cookies: { session: "a".repeat(64) } };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.equal(called, false);
});

test("requireAuth: accepts valid session cookie and populates req.user", () => {
  const req = { cookies: { session: token } };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.id, userId);
  assert.equal(req.user.username, "authtest");
  assert.ok(req.sessionData.csrfToken, "csrfToken populated");
  assert.equal(req.sessionData.tokenHash, sha256(token));
});

// ---------------------------------------------------------------------------
// requireCsrf
// ---------------------------------------------------------------------------

test("requireCsrf: blocks request without X-CSRF-Token header", () => {
  const req = { headers: {}, sessionData: { csrfToken } };
  const res = mockRes();
  let called = false;
  requireCsrf(req, res, () => { called = true; });
  assert.equal(res._status, 403);
  assert.ok(/csrf/i.test(res._body.error));
  assert.equal(called, false);
});

test("requireCsrf: blocks request with wrong CSRF token", () => {
  const req = { headers: { "x-csrf-token": "wrong-token" }, sessionData: { csrfToken } };
  const res = mockRes();
  let called = false;
  requireCsrf(req, res, () => { called = true; });
  assert.equal(res._status, 403);
  assert.equal(called, false);
});

test("requireCsrf: passes request with correct CSRF token", () => {
  const req = { headers: { "x-csrf-token": csrfToken }, sessionData: { csrfToken } };
  const res = mockRes();
  let called = false;
  requireCsrf(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("requireCsrf: blocks when sessionData is missing", () => {
  const req = { headers: { "x-csrf-token": csrfToken }, sessionData: undefined };
  const res = mockRes();
  let called = false;
  requireCsrf(req, res, () => { called = true; });
  assert.equal(res._status, 403);
  assert.equal(called, false);
});
