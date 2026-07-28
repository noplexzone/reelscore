import { createHmac, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { SESSION_SECRET } from "./config.js";

const PURPOSES = new Set(["verify_email", "password_reset"]);
const TOKEN_BYTES = 32;

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function requirePurpose(purpose) {
  if (!PURPOSES.has(purpose)) throw new TypeError("Unsupported account token purpose.");
  return purpose;
}

function requireEpochMs(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer epoch millisecond value.`);
  return value;
}

export function accountTokenDigest(token, purpose, secret = SESSION_SECRET) {
  requirePurpose(purpose);
  if (typeof token !== "string" || token.length < 32) throw new TypeError("Account token is invalid.");
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Account token secret is not configured safely.");
  return createHmac("sha256", secret)
    .update(`reelscore-account-token:v1:${purpose}\0`, "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function issueAccountToken({ userId, purpose, ttlMs, now = Date.now() }) {
  requirePurpose(purpose);
  requireEpochMs(now, "now");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer.");
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new RangeError("Account token expiry is outside the supported range.");

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const digest = accountTokenDigest(token, purpose);
  const insert = db.transaction(() => {
    db.prepare(`
      UPDATE account_tokens
      SET consumed_at = ?
      WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
    `).run(now, userId, purpose);
    return db.prepare(`
      INSERT INTO account_tokens (user_id, purpose, token_digest, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, purpose, digest, expiresAt, now);
  });
  const result = insert();
  return { token, expiresAt, id: Number(result.lastInsertRowid) };
}

export function consumeAccountToken({ token, purpose, now = Date.now(), onConsume = null }) {
  requirePurpose(purpose);
  requireEpochMs(now, "now");
  let digest;
  try {
    digest = accountTokenDigest(token, purpose);
  } catch {
    return null;
  }

  return db.transaction(() => {
    const row = db.prepare(`
      SELECT id, user_id, purpose
      FROM account_tokens
      WHERE token_digest = ?
        AND purpose = ?
        AND consumed_at IS NULL
        AND expires_at > ?
    `).get(digest, purpose, now);
    if (!row) return null;
    const changed = db.prepare(`
      UPDATE account_tokens
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(now, row.id, now).changes;
    if (changed !== 1) return null;
    const consumed = { userId: row.user_id, purpose: row.purpose };
    if (onConsume) onConsume(consumed);
    return consumed;
  })();
}
