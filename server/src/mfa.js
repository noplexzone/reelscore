import { createHmac, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { db } from "./db.js";
import { IS_HOSTED, SESSION_SECRET } from "./config.js";
import { decryptCredential, encryptCredential } from "./providers.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;

function totpContext(userId, field) {
  return { userId, connectionId: "account-mfa", provider: "totp", field };
}
function normalizeCode(code) {
  return String(code || "").replace(/[\s-]/gu, "").toUpperCase();
}
function keyedDigest(prefix, value) {
  return createHmac("sha256", SESSION_SECRET).update(`${prefix}:${value}`).digest("hex");
}
export function challengeTokenDigest(token) {
  return keyedDigest("mfa-challenge", String(token || ""));
}
function recoveryCodeDigest(code) {
  return keyedDigest("mfa-recovery", normalizeCode(code));
}
function totpFor(secret, username) {
  return new OTPAuth.TOTP({ issuer: "ReelScore", label: username, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
function validTotp(secret, username, code, now = Date.now()) {
  const token = normalizeCode(code);
  if (!/^\d{6}$/u.test(token)) return false;
  return totpFor(secret, username).validate({ token, timestamp: now, window: 1 }) !== null;
}
function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(10).toString("hex").toUpperCase().match(/.{1,5}/gu).join("-"));
}
function replaceRecoveryCodes(userId, now = Date.now()) {
  const codes = generateRecoveryCodes();
  db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id=?").run(userId);
  const insert = db.prepare("INSERT INTO mfa_recovery_codes (user_id,code_digest,created_at) VALUES (?,?,?)");
  for (const code of codes) insert.run(userId, recoveryCodeDigest(code), now);
  return codes;
}
function activeSecret(user) {
  if (!user?.totp_secret_encrypted || !user.mfa_enabled_at) return null;
  return decryptCredential(user.totp_secret_encrypted, totpContext(user.id, "active-secret"));
}
function consumeRecoveryCode(userId, code, now = Date.now()) {
  const result = db.prepare(`UPDATE mfa_recovery_codes SET used_at=?
    WHERE user_id=? AND code_digest=? AND used_at IS NULL`).run(now, userId, recoveryCodeDigest(code));
  return result.changes === 1;
}

export function beginTotpSetup(user) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const encrypted = encryptCredential(secret, totpContext(user.id, "pending-secret"));
  db.prepare("UPDATE users SET totp_pending_encrypted=? WHERE id=?").run(encrypted, user.id);
  return { secret, otpauth_uri: totpFor(secret, user.username).toString() };
}

export function confirmTotpSetup(userId, code, { currentSessionHash = null, now = Date.now() } = {}) {
  return db.transaction(() => {
    const user = db.prepare("SELECT id,username,totp_pending_encrypted,mfa_enabled_at FROM users WHERE id=?").get(userId);
    if (!user?.totp_pending_encrypted) return null;
    const secret = decryptCredential(user.totp_pending_encrypted, totpContext(user.id, "pending-secret"));
    if (!validTotp(secret, user.username, code, now)) return null;
    const encrypted = encryptCredential(secret, totpContext(user.id, "active-secret"));
    db.prepare("UPDATE users SET totp_pending_encrypted=NULL,totp_secret_encrypted=?,mfa_enabled_at=? WHERE id=?")
      .run(encrypted, now, user.id);
    const recoveryCodes = replaceRecoveryCodes(user.id, now);
    db.prepare("DELETE FROM mfa_login_challenges WHERE user_id=?").run(user.id);
    if (currentSessionHash) db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(user.id, currentSessionHash);
    else db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    return { mfa_enabled: true, recovery_codes: recoveryCodes };
  })();
}

export function issueLoginChallenge(userId, { ip = null, userAgent = null, now = Date.now() } = {}) {
  const token = randomBytes(32).toString("base64url");
  const digest = challengeTokenDigest(token);
  db.transaction(() => {
    db.prepare("DELETE FROM mfa_login_challenges WHERE expires_at<=? OR consumed_at IS NOT NULL").run(now);
    db.prepare(`INSERT INTO mfa_login_challenges
      (challenge_digest,user_id,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?)`)
      .run(digest, userId, now, now + CHALLENGE_TTL_MS, ip, userAgent);
  })();
  return { challenge_token: token, expires_at: now + CHALLENGE_TTL_MS };
}

export function verifyMfaProof(userId, code, now = Date.now()) {
  const user = db.prepare("SELECT id,username,totp_secret_encrypted,mfa_enabled_at FROM users WHERE id=?").get(userId);
  const secret = activeSecret(user);
  if (!secret) return false;
  if (validTotp(secret, user.username, code, now)) return true;
  return consumeRecoveryCode(user.id, code, now);
}

export function verifyLoginChallenge({ token, code, now = Date.now(), onVerified }) {
  return db.transaction(() => {
    const digest = challengeTokenDigest(token);
    const challenge = db.prepare(`SELECT c.*,u.username,u.role,u.email,u.email_verified_at,u.status,
        u.totp_secret_encrypted,u.mfa_enabled_at
      FROM mfa_login_challenges c JOIN users u ON u.id=c.user_id
      WHERE c.challenge_digest=? AND c.consumed_at IS NULL AND c.expires_at>?`).get(digest, now);
    if (!challenge || challenge.status !== "active" || !verifyMfaProof(challenge.user_id, code, now)) return null;
    const consumed = db.prepare(`UPDATE mfa_login_challenges SET consumed_at=?
      WHERE challenge_digest=? AND consumed_at IS NULL AND expires_at>?`).run(now, digest, now);
    if (consumed.changes !== 1) return null;
    return onVerified ? onVerified(challenge) : challenge;
  })();
}

export function regenerateRecoveryCodes(userId, code, now = Date.now()) {
  return db.transaction(() => {
    if (!verifyMfaProof(userId, code, now)) return null;
    return replaceRecoveryCodes(userId, now);
  })();
}

export function disableMfa(userId, { code, currentSessionHash, now = Date.now(), allowAdmin = false } = {}) {
  return db.transaction(() => {
    const user = db.prepare("SELECT id,role,status,mfa_enabled_at FROM users WHERE id=?").get(userId);
    if (!user?.mfa_enabled_at) return null;
    if (!allowAdmin && IS_HOSTED && user.role === "admin" && user.status === "active") {
      const error = new Error("Demote this active administrator before disabling MFA.");
      error.status = 409;
      throw error;
    }
    if (!allowAdmin && !verifyMfaProof(userId, code, now)) return null;
    db.prepare("UPDATE users SET totp_pending_encrypted=NULL,totp_secret_encrypted=NULL,mfa_enabled_at=NULL WHERE id=?").run(userId);
    db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM mfa_login_challenges WHERE user_id=?").run(userId);
    if (currentSessionHash) db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(userId, currentSessionHash);
    else db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
    return true;
  })();
}

export function mfaStatus(userId) {
  const user = db.prepare("SELECT mfa_enabled_at FROM users WHERE id=?").get(userId);
  const remaining = db.prepare("SELECT COUNT(*) c FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL").get(userId).c;
  return { mfa_enabled: !!user?.mfa_enabled_at, recovery_codes_remaining: remaining };
}
