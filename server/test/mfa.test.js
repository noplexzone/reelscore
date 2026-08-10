process.env.DATA_DIR = `/tmp/rs-mfa-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.CREDENTIAL_ENCRYPTION_KEY = "mfa-credential-key-that-is-at-least-32-characters";
process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "mfa-test";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startTestServer, parseCookies, rawSetCookies } from "./helpers/server.js";

let srv, db, cookie, csrf, secret, recoveryCodes, preEnrollmentCookie;
const password = "mfa-password-123";

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/u, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(value, now = Date.now()) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", decodeBase32(value)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}
async function post(path, body, { session = cookie, token = csrf } = {}) {
  return fetch(`${srv.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(session ? { Cookie: `session=${session}` } : {}), ...(token ? { "X-CSRF-Token": token } : {}) }, body: JSON.stringify(body || {}) });
}
async function login() {
  const response = await post("/api/auth/login", { username: "mfauser", password }, { session: null, token: null });
  return { response, body: await response.json() };
}
async function completeChallenge(challengeToken, code) {
  const response = await post("/api/auth/mfa/challenge", { challenge_token: challengeToken, code }, { session: null, token: null });
  return { response, body: await response.json() };
}

before(async () => {
  srv = await startTestServer();
  ({ db } = await import("../src/db.js"));
  const registered = await post("/api/auth/register", { username: "mfauser", password }, { session: null, token: null });
  const body = await registered.json();
  cookie = parseCookies(registered).session;
  csrf = body.csrf_token;
});
after(async () => { if (srv) await srv.close(); });

test("MFA setup is CSRF-protected and stores only an encrypted pending TOTP secret", async () => {
  const denied = await post("/api/auth/mfa/setup/begin", {}, { session: cookie, token: null });
  assert.equal(denied.status, 403);
  const response = await post("/api/auth/mfa/setup/begin", {});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.match(body.secret, /^[A-Z2-7]+$/u);
  assert.match(body.otpauth_uri, /^otpauth:\/\/totp\//u);
  secret = body.secret;
  const row = db.prepare("SELECT totp_pending_encrypted,totp_secret_encrypted,mfa_enabled_at FROM users WHERE username='mfauser'").get();
  assert.ok(row.totp_pending_encrypted.startsWith("v1.mfa-test."));
  assert.equal(row.totp_pending_encrypted.includes(secret), false);
  assert.equal(row.totp_secret_encrypted, null);
  assert.equal(row.mfa_enabled_at, null);
});

test("MFA confirmation rejects invalid codes, enables only after a current TOTP, and displays recovery codes once", async () => {
  const invalid = await post("/api/auth/mfa/setup/confirm", { code: "000000" });
  assert.equal(invalid.status, 400);
  assert.equal(db.prepare("SELECT mfa_enabled_at FROM users WHERE username='mfauser'").get().mfa_enabled_at, null);
  const preEnrollment = await login();
  preEnrollmentCookie = parseCookies(preEnrollment.response).session;
  assert.ok(preEnrollmentCookie);
  const response = await post("/api/auth/mfa/setup/confirm", { code: totp(secret) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mfa_enabled, true);
  assert.equal(body.recovery_codes.length, 10);
  recoveryCodes = body.recovery_codes;
  const user = db.prepare("SELECT totp_pending_encrypted,totp_secret_encrypted,mfa_enabled_at FROM users WHERE username='mfauser'").get();
  assert.equal(user.totp_pending_encrypted, null);
  assert.ok(user.totp_secret_encrypted.startsWith("v1.mfa-test."));
  assert.equal(user.totp_secret_encrypted.includes(secret), false);
  assert.ok(user.mfa_enabled_at > 0);
  assert.equal((await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${preEnrollmentCookie}` } })).status, 401);
  assert.equal((await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${cookie}` } })).status, 200);
  const stored = db.prepare("SELECT code_digest FROM mfa_recovery_codes WHERE user_id=(SELECT id FROM users WHERE username='mfauser')").all();
  assert.equal(stored.length, 10);
  for (const code of recoveryCodes) assert.equal(stored.some((row) => row.code_digest === code || row.code_digest.includes(code)), false);
  const status = await fetch(`${srv.base}/api/auth/mfa/status`, { headers: { Cookie: `session=${cookie}` } });
  assert.deepEqual(await status.json(), { mfa_enabled: true, recovery_codes_remaining: 10 });
});

test("password login for an MFA user issues only a short-lived challenge and no full session cookie", async () => {
  const sessionsBefore = db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='mfauser')").get().c;
  const { response, body } = await login();
  assert.equal(response.status, 202);
  assert.equal(body.mfa_required, true);
  assert.ok(body.challenge_token);
  assert.equal(body.user, undefined);
  assert.equal(body.csrf_token, undefined);
  assert.equal(rawSetCookies(response).some((value) => value.startsWith("session=")), false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='mfauser')").get().c, sessionsBefore);
});

test("a valid TOTP consumes a login challenge atomically, issues the normal session, and cannot replay", async () => {
  const { body: loginBody } = await login();
  const completed = await completeChallenge(loginBody.challenge_token, totp(secret));
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.ok(completed.body.csrf_token);
  assert.equal(completed.body.user.username, "mfauser");
  assert.ok(parseCookies(completed.response).session);
  const replay = await completeChallenge(loginBody.challenge_token, totp(secret));
  assert.equal(replay.response.status, 401);
});

test("MFA login challenges enforce exact epoch-millisecond expiry", async () => {
  const { challengeTokenDigest } = await import("../src/mfa.js");
  const near = await login();
  db.prepare("UPDATE mfa_login_challenges SET expires_at=? WHERE challenge_digest=?").run(Date.now() + 500, challengeTokenDigest(near.body.challenge_token));
  assert.equal((await completeChallenge(near.body.challenge_token, totp(secret))).response.status, 200);
  const expired = await login();
  db.prepare("UPDATE mfa_login_challenges SET expires_at=? WHERE challenge_digest=?").run(Date.now() - 1, challengeTokenDigest(expired.body.challenge_token));
  assert.equal((await completeChallenge(expired.body.challenge_token, totp(secret))).response.status, 401);
});

test("recovery codes are individually one-use and challenge failure does not consume the challenge", async () => {
  const first = await login();
  assert.equal((await completeChallenge(first.body.challenge_token, "wrong-code")).response.status, 401);
  assert.equal((await completeChallenge(first.body.challenge_token, recoveryCodes[0])).response.status, 200);
  const second = await login();
  assert.equal((await completeChallenge(second.body.challenge_token, recoveryCodes[0])).response.status, 401);
  assert.equal((await completeChallenge(second.body.challenge_token, recoveryCodes[1])).response.status, 200);
});

test("recovery regeneration requires password plus MFA proof and invalidates prior codes", async () => {
  assert.equal((await post("/api/auth/mfa/recovery/regenerate", { password, code: "bad" })).status, 401);
  const response = await post("/api/auth/mfa/recovery/regenerate", { password, code: totp(secret) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.recovery_codes.length, 10);
  const old = recoveryCodes[2];
  recoveryCodes = body.recovery_codes;
  const oldLogin = await login();
  assert.equal((await completeChallenge(oldLogin.body.challenge_token, old)).response.status, 401);
});

test("session APIs expose safe metadata, preserve current session, and revoke one or all other sessions", async () => {
  const current = await login();
  const currentComplete = await completeChallenge(current.body.challenge_token, totp(secret));
  const currentCookie = parseCookies(currentComplete.response).session;
  const currentCsrf = currentComplete.body.csrf_token;
  const other = await login();
  const otherComplete = await completeChallenge(other.body.challenge_token, totp(secret));
  const otherCookie = parseCookies(otherComplete.response).session;
  db.prepare(`INSERT INTO sessions (token_hash,public_id,user_id,csrf_token,expires_at,last_seen_at)
    VALUES ('expired-test-hash','expired-test-id',(SELECT id FROM users WHERE username='mfauser'),'expired-csrf',datetime('now','-1 day'),datetime('now','-8 days'))`).run();
  const listed = await fetch(`${srv.base}/api/auth/sessions`, { headers: { Cookie: `session=${currentCookie}` } });
  const listedBody = await listed.json();
  assert.equal(listed.status, 200);
  assert.ok(listedBody.sessions.length >= 2);
  assert.equal(listedBody.sessions.filter((item) => item.current).length, 1);
  assert.equal(JSON.stringify(listedBody).includes("token_hash"), false);
  assert.equal(JSON.stringify(listedBody).includes(currentCookie), false);
  assert.equal(listedBody.sessions.some((item) => item.id === "expired-test-id"), false);
  const otherSession = listedBody.sessions.find((item) => !item.current);
  assert.equal((await post(`/api/auth/sessions/${otherSession.id}/revoke`, {}, { session: currentCookie, token: currentCsrf })).status, 200);
  assert.equal((await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${otherCookie}` } })).status, 401);
  assert.equal((await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${currentCookie}` } })).status, 200);
  const another = await login();
  const anotherComplete = await completeChallenge(another.body.challenge_token, totp(secret));
  const anotherCookie = parseCookies(anotherComplete.response).session;
  assert.equal((await post("/api/auth/sessions/revoke-others", {}, { session: currentCookie, token: currentCsrf })).status, 200);
  assert.equal((await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${anotherCookie}` } })).status, 401);
  assert.equal((await fetch(`${srv.base}/api/me`, { headers: { Cookie: `session=${currentCookie}` } })).status, 200);
  cookie = currentCookie;
  csrf = currentCsrf;
});

test("self-hosted administrators can disable MFA only with password plus MFA proof, revoking other sessions and challenges", async () => {
  const extra = await login();
  const activeChallenge = extra.body.challenge_token;
  assert.equal((await post("/api/auth/mfa/disable", { password: "wrong", code: totp(secret) })).status, 401);
  assert.equal((await post("/api/auth/mfa/disable", { password })).status, 401);
  assert.ok(db.prepare("SELECT mfa_enabled_at FROM users WHERE username='mfauser'").get().mfa_enabled_at);
  const response = await post("/api/auth/mfa/disable", { password, code: totp(secret) });
  assert.equal(response.status, 200, await response.text());
  const user = db.prepare("SELECT totp_secret_encrypted,mfa_enabled_at FROM users WHERE username='mfauser'").get();
  assert.equal(user.totp_secret_encrypted, null);
  assert.equal(user.mfa_enabled_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mfa_recovery_codes WHERE user_id=(SELECT id FROM users WHERE username='mfauser')").get().c, 0);
  assert.equal((await completeChallenge(activeChallenge, recoveryCodes[0])).response.status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='mfauser')").get().c, 1);
  const normalLogin = await login();
  assert.equal(normalLogin.response.status, 200);
  assert.ok(normalLogin.body.csrf_token);
});
