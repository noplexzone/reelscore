process.env.DATA_DIR = `/tmp/rs-public-auth-${process.pid}`;
process.env.SESSION_SECRET = "hosted-session-secret-that-is-at-least-32-characters";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "hosted";
process.env.PUBLIC_URL = "https://hosted.example.test";
process.env.CREDENTIAL_ENCRYPTION_KEY = "independent-credential-key-at-least-32-characters";
process.env.EMAIL_OUTBOX_ENCRYPTION_KEY = "independent-email-outbox-key-at-least-32-characters";
process.env.EMAIL_OUTBOX_ENCRYPTION_KEY_ID = "email-test";
process.env.PLEX_ALLOWED_SERVER_ID = "allowed-machine";
process.env.PLEX_ALLOWED_ORIGINS = "https://plex.example.test:32400";
process.env.PLEX_CLIENT_IDENTIFIER = "reelscore-public-auth-test";
process.env.TRUSTED_PROXY_CIDRS = "172.29.0.2/32";
process.env.BOOTSTRAP_ADMIN_TOKEN = "bootstrap-token-that-is-at-least-32-characters";
process.env.EMAIL_PROVIDER = "capture";

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import fs from "node:fs";

let server, base, db, getEmailJobForDelivery, requireVerifiedEmail;
let adminCookie, adminCsrf;
const publicHeaders = { Host: "hosted.example.test", Origin: "https://hosted.example.test" };

function rawRequest(pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: server.address().port,
      path: pathname,
      method,
      headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function post(pathname, body, extraHeaders = {}) {
  return rawRequest(pathname, {
    method: "POST",
    headers: { ...publicHeaders, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function tokenFromLatestJob(kind, userId) {
  const row = db.prepare("SELECT id FROM email_jobs WHERE kind=? AND user_id=? ORDER BY id DESC LIMIT 1").get(kind, userId);
  assert.ok(row, `${kind} job exists`);
  const job = getEmailJobForDelivery(row.id);
  return new URL(job.payload.url).searchParams.get("token");
}

before(async () => {
  const { createApp } = await import("../src/index.js");
  ({ db } = await import("../src/db.js"));
  ({ getEmailJobForDelivery } = await import("../src/email.js"));
  ({ requireVerifiedEmail } = await import("../src/auth.js"));
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const bootstrap = await post("/api/auth/bootstrap", {
    username: "hostadmin",
    password: "long-unique-bootstrap-password",
  }, { "x-bootstrap-token": process.env.BOOTSTRAP_ADMIN_TOKEN });
  assert.equal(bootstrap.status, 200, bootstrap.text);
  const bootstrapBody = JSON.parse(bootstrap.text);
  adminCsrf = bootstrapBody.csrf_token;
  adminCookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test("open hosted config advertises registration", async () => {
  const response = await rawRequest("/api/auth/config", { headers: { Host: "hosted.example.test" } });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.registration_enabled, true);
  assert.equal(body.registration_mode, "open");
});

test("migrated account can claim and verify email without losing its current session", async () => {
  const claim = await post("/api/auth/email/claim", { email: "Admin@Example.com" }, {
    Cookie: adminCookie,
    "x-csrf-token": adminCsrf,
  });
  assert.equal(claim.status, 202, claim.text);
  const admin = db.prepare("SELECT * FROM users WHERE username='hostadmin'").get();
  assert.equal(admin.email_normalized, "admin@example.com");
  assert.equal(admin.email_verified_at, null);
  const verify = await post("/api/auth/email/verify", {
    token: tokenFromLatestJob("email_verification", admin.id),
  });
  assert.equal(verify.status, 200, verify.text);
  assert.ok(db.prepare("SELECT email_verified_at FROM users WHERE id=?").get(admin.id).email_verified_at);
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE user_id=?").get(admin.id), "claim does not revoke current session");
});

test("hosted registration creates an unverified account and encrypted email job but no session", async () => {
  const response = await post("/api/auth/register", {
    username: "publicuser",
    email: " Public.User@Example.COM ",
    password: "correct horse public battery",
  });
  assert.equal(response.status, 202, response.text);
  assert.equal(response.headers["set-cookie"], undefined);
  const user = db.prepare("SELECT * FROM users WHERE username='publicuser'").get();
  assert.equal(user.email_normalized, "public.user@example.com");
  assert.equal(user.email_verified_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?").get(user.id).c, 0);
  const stored = db.prepare("SELECT * FROM email_jobs WHERE user_id=?").get(user.id);
  const rawToken = tokenFromLatestJob("email_verification", user.id);
  assert.equal(JSON.stringify(stored).includes(rawToken), false);
});

test("unverified hosted account cannot sign in and verified account can", async () => {
  const user = db.prepare("SELECT id FROM users WHERE username='publicuser'").get();
  const blocked = await post("/api/auth/login", { username: "publicuser", password: "correct horse public battery" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers["set-cookie"], undefined);

  const verify = await post("/api/auth/email/verify", {
    token: tokenFromLatestJob("email_verification", user.id),
  });
  assert.equal(verify.status, 200, verify.text);
  const replay = await post("/api/auth/email/verify", {
    token: tokenFromLatestJob("email_verification", user.id),
  });
  assert.equal(replay.status, 400);

  const login = await post("/api/auth/login", { username: "publicuser", password: "correct horse public battery" });
  assert.equal(login.status, 200, login.text);
  assert.match(String(login.headers["set-cookie"]), /^__Host-reelscore-session=/);
  assert.equal(JSON.parse(login.text).user.email_verified, true);
});

test("duplicate and unknown email operations return the same generic response shape", async () => {
  const duplicate = await post("/api/auth/register", {
    username: "differentname",
    email: "public.user@example.com",
    password: "another correct public password",
  });
  const unknownResend = await post("/api/auth/verification/resend", { email: "unknown@example.com" });
  const unknownReset = await post("/api/auth/password-reset/request", { email: "unknown@example.com" });
  assert.equal(duplicate.status, 202);
  assert.equal(unknownResend.status, 202);
  assert.equal(unknownReset.status, 202);
  assert.deepEqual(JSON.parse(duplicate.text), JSON.parse(unknownResend.text));
  assert.deepEqual(JSON.parse(duplicate.text), JSON.parse(unknownReset.text));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email_normalized='public.user@example.com'").get().c, 1);
});

test("password reset consumes one-use token and revokes all sessions", async () => {
  const user = db.prepare("SELECT id FROM users WHERE username='publicuser'").get();
  const request = await post("/api/auth/password-reset/request", { email: "PUBLIC.USER@example.com" });
  assert.equal(request.status, 202);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?").get(user.id).c > 0);
  const resetToken = tokenFromLatestJob("password_reset", user.id);
  const complete = await post("/api/auth/password-reset/complete", {
    token: resetToken,
    password: "replacement public password",
  });
  assert.equal(complete.status, 200, complete.text);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?").get(user.id).c, 0);
  const replay = await post("/api/auth/password-reset/complete", {
    token: resetToken,
    password: "another replacement password",
  });
  assert.equal(replay.status, 400);
  const oldLogin = await post("/api/auth/login", { username: "publicuser", password: "correct horse public battery" });
  const newLogin = await post("/api/auth/login", { username: "publicuser", password: "replacement public password" });
  assert.equal(oldLogin.status, 401);
  assert.equal(newLogin.status, 200);
});

test("verified-email middleware denies provider/import access until verification", () => {
  let status;
  let body;
  let called = false;
  requireVerifiedEmail(
    { user: { emailVerified: false } },
    { status(value) { status = value; return this; }, json(value) { body = value; return this; } },
    () => { called = true; },
  );
  assert.equal(status, 403);
  assert.match(body.error, /verify/i);
  assert.equal(called, false);
});
