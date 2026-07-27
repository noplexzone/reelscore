// Tests requireAuth middleware with valid/invalid JWTs.
process.env.JWT_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

const { requireAuth } = await import("../src/auth.js");

const SECRET = process.env.JWT_SECRET;

function mockRes() {
  let capturedStatus = null;
  let capturedBody = null;
  const res = {
    status(s) {
      capturedStatus = s;
      return { json(b) { capturedBody = b; } };
    },
    get _status() { return capturedStatus; },
    get _body() { return capturedBody; },
  };
  return res;
}

test("requireAuth: rejects request with no Authorization header", () => {
  const req = { headers: {} };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.ok(/sign in/i.test(res._body.error));
  assert.equal(called, false);
});

test("requireAuth: rejects malformed token", () => {
  const req = { headers: { authorization: "Bearer not.a.valid.token" } };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.equal(called, false);
});

test("requireAuth: rejects token signed with wrong secret", () => {
  const badToken = jwt.sign({ id: 1, username: "eve" }, "wrong-secret", { expiresIn: "1h" });
  const req = { headers: { authorization: `Bearer ${badToken}` } };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.equal(called, false);
});

test("requireAuth: accepts valid signed token and populates req.user", () => {
  const token = jwt.sign({ id: 42, username: "alice" }, SECRET, { expiresIn: "1h" });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.id, 42);
  assert.equal(req.user.username, "alice");
});
