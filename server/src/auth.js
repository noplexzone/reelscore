import bcrypt from "bcryptjs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { BOOTSTRAP_ADMIN_TOKEN, IS_HOSTED, PUBLIC_URL, REGISTRATION_MODE, SESSION_SECRET } from "./config.js";
import { consumeAccountToken, normalizeEmail } from "./account-tokens.js";
import { issueAccountEmail } from "./account-email.js";
import { normalizeEmailRecipient } from "./email.js";
import {
  beginTotpSetup,
  confirmTotpSetup,
  disableMfa,
  issueLoginChallenge,
  mfaStatus,
  regenerateRecoveryCodes,
  verifyLoginChallenge,
} from "./mfa.js";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_ACTIVE_SESSIONS = 10;
export const SESSION_COOKIE_NAME = IS_HOSTED ? "__Host-reelscore-session" : "session";

export function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function sha256(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionTokenHash(token) {
  return createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: IS_HOSTED,
    maxAge: SESSION_DURATION_MS,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: "lax", path: "/", secure: IS_HOSTED });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export function createSession(userId, { ip = null, userAgent = null } = {}) {
  const token = randomHex(32);
  const csrfToken = randomHex(32);
  const tokenHash = sessionTokenHash(token);
  const publicId = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString().replace("T", " ").slice(0, 19);

  db.prepare(
    `INSERT INTO sessions (token_hash, public_id, user_id, csrf_token, expires_at, ip, user_agent, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(tokenHash, publicId, userId, csrfToken, expiresAt, ip, userAgent);
  db.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?
  )`).run(userId, userId, MAX_ACTIVE_SESSIONS);

  return { token, csrfToken };
}

export function deleteSession(tokenHash) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again later." },
});

const accountEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many email requests. Please try again later." },
});

const mfaChallengeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many MFA attempts. Please try again later." },
});

const mfaAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many MFA account changes. Please try again later." },
});

const GENERIC_EMAIL_RESPONSE = {
  ok: true,
  message: "If the account is eligible, an email will arrive shortly.",
};

function validEmail(value) {
  try {
    normalizeEmailRecipient(value);
    return true;
  } catch {
    return false;
  }
}

function queueAccountEmail({ userId, email, purpose, now = Date.now() }) {
  return issueAccountEmail({
    userId,
    recipient: email,
    purpose,
    publicUrl: PUBLIC_URL,
    now,
  });
}

function pendingEmailResponse(res) {
  return res.status(202).json(GENERIC_EMAIL_RESPONSE);
}

// ---------------------------------------------------------------------------
// Auth router
// ---------------------------------------------------------------------------

export const authRouter = Router();

authRouter.get("/config", (_req, res) => {
  res.json({
    app_mode: IS_HOSTED ? "hosted" : "self_hosted",
    registration_enabled: REGISTRATION_MODE !== "closed" && (!IS_HOSTED || REGISTRATION_MODE === "open"),
    registration_mode: REGISTRATION_MODE,
    plex_enabled: true,
    trakt_enabled: !!(process.env.TRAKT_CLIENT_ID && process.env.TRAKT_CLIENT_SECRET),
  });
});

authRouter.post("/register", registrationLimiter, async (req, res) => {
  if (REGISTRATION_MODE === "closed" || (IS_HOSTED && REGISTRATION_MODE !== "open")) {
    return res.status(403).json({ error: "Public registration is disabled." });
  }

  const { username, password, invite_code } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters (letters, numbers, _)." });
  }
  const minimumPasswordLength = IS_HOSTED ? 12 : 8;
  if (!password || password.length < minimumPasswordLength) {
    return res.status(400).json({ error: `Password must be at least ${minimumPasswordLength} characters.` });
  }

  if (IS_HOSTED) {
    if (db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c === 0) {
      return res.status(503).json({ error: "Registration is not available until administrator setup is complete." });
    }
    if (!validEmail(req.body?.email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    const email = String(req.body.email).trim();
    const emailNormalized = normalizeEmail(email);
    const hash = await bcrypt.hash(password, 10);
    try {
      db.transaction(() => {
        const userId = Number(db.prepare(`
          INSERT INTO users (username, password_hash, email, email_normalized)
          VALUES (?, ?, ?, ?)
        `).run(username, hash, email, emailNormalized).lastInsertRowid);
        queueAccountEmail({ userId, email, purpose: "verify_email" });
      })();
    } catch (error) {
      const message = String(error?.message || "");
      if (/users\.username|UNIQUE constraint failed: users\.username/i.test(message)) {
        return res.status(409).json({ error: "That username is taken." });
      }
      if (/email_normalized|idx_users_email_normalized/i.test(message)) {
        return pendingEmailResponse(res);
      }
      return res.status(500).json({ error: "Registration could not be completed." });
    }
    return pendingEmailResponse(res);
  }

  if (REGISTRATION_MODE === "invite") {
    if (!invite_code) return res.status(403).json({ error: "An invite code is required to register." });
    const invite = db.prepare(`SELECT * FROM invites WHERE token_hash=? AND revoked=0
      AND used_by IS NULL AND julianday(expires_at)>julianday('now')`).get(sha256(String(invite_code)));
    if (!invite) return res.status(403).json({ error: "Invalid or expired invite code." });
  }

  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (exists) return res.status(409).json({ error: "That username is taken." });
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
  const userId = info.lastInsertRowid;
  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
  if (adminCount === 0) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  if (REGISTRATION_MODE === "invite" && invite_code) {
    db.prepare("UPDATE invites SET used_by=?, used_at=datetime('now') WHERE token_hash=?")
      .run(userId, sha256(String(invite_code)));
  }
  const { token, csrfToken } = createSession(userId, { ip: req.ip, userAgent: req.headers["user-agent"] || null });
  setSessionCookie(res, token);
  return res.json({ csrf_token: csrfToken, user: { id: userId, username, role: "user" } });
});

authRouter.post("/email/verify", accountEmailLimiter, (req, res) => {
  const token = String(req.body?.token || "");
  const now = Date.now();
  const consumed = consumeAccountToken({
    token,
    purpose: "verify_email",
    now,
    onConsume: ({ userId }) => {
      db.prepare("UPDATE users SET email_verified_at=? WHERE id=?").run(now, userId);
    },
  });
  if (!consumed) return res.status(400).json({ error: "Verification link is invalid or expired." });
  return res.json({ ok: true });
});

authRouter.post("/verification/resend", accountEmailLimiter, (req, res) => {
  const emailNormalized = normalizeEmail(req.body?.email);
  if (validEmail(emailNormalized)) {
    const user = db.prepare(`
      SELECT id, email FROM users
      WHERE email_normalized=? AND email_verified_at IS NULL AND status='active'
    `).get(emailNormalized);
    if (user) {
      try {
        db.transaction(() => queueAccountEmail({ userId: user.id, email: user.email, purpose: "verify_email" }))();
      } catch {
        // Preserve an enumeration-resistant response. Operators inspect outbox health separately.
      }
    }
  }
  return pendingEmailResponse(res);
});

authRouter.post("/password-reset/request", accountEmailLimiter, (req, res) => {
  const emailNormalized = normalizeEmail(req.body?.email);
  if (validEmail(emailNormalized)) {
    const user = db.prepare(`
      SELECT id, email FROM users
      WHERE email_normalized=? AND email_verified_at IS NOT NULL AND status='active'
    `).get(emailNormalized);
    if (user) {
      try {
        db.transaction(() => queueAccountEmail({ userId: user.id, email: user.email, purpose: "password_reset" }))();
      } catch {
        // Preserve an enumeration-resistant response. Operators inspect outbox health separately.
      }
    }
  }
  return pendingEmailResponse(res);
});

authRouter.post("/password-reset/complete", authLimiter, async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (password.length < 12) return res.status(400).json({ error: "Password must be at least 12 characters." });
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();
  const consumed = consumeAccountToken({
    token,
    purpose: "password_reset",
    now,
    onConsume: ({ userId }) => {
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash, userId);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM mfa_login_challenges WHERE user_id=?").run(userId);
    },
  });
  if (!consumed) return res.status(400).json({ error: "Password reset link is invalid or expired." });
  return res.json({ ok: true });
});

authRouter.post("/email/claim", requireAuth, requireCsrf, accountEmailLimiter, (req, res) => {
  if (!IS_HOSTED) return res.sendStatus(404);
  if (!validEmail(req.body?.email)) return res.status(400).json({ error: "Enter a valid email address." });
  const email = String(req.body.email).trim();
  const emailNormalized = normalizeEmail(email);
  const current = db.prepare("SELECT email_verified_at FROM users WHERE id=?").get(req.user.id);
  if (current?.email_verified_at) return res.status(409).json({ error: "This account already has a verified email." });
  try {
    db.transaction(() => {
      db.prepare("UPDATE users SET email=?,email_normalized=?,email_verified_at=NULL WHERE id=?")
        .run(email, emailNormalized, req.user.id);
      queueAccountEmail({ userId: req.user.id, email, purpose: "verify_email" });
    })();
  } catch (error) {
    if (/email_normalized|idx_users_email_normalized/i.test(String(error?.message || ""))) {
      return res.status(409).json({ error: "That email address is unavailable." });
    }
    return res.status(500).json({ error: "Email claim could not be completed." });
  }
  return pendingEmailResponse(res);
});

authRouter.post("/bootstrap", authLimiter, async (req, res) => {
  if (!IS_HOSTED || !BOOTSTRAP_ADMIN_TOKEN) return res.sendStatus(404);
  const supplied = String(req.headers["x-bootstrap-token"] || "");
  const expectedHash = Buffer.from(sha256(BOOTSTRAP_ADMIN_TOKEN), "hex");
  const suppliedHash = Buffer.from(sha256(supplied), "hex");
  if (!timingSafeEqual(expectedHash, suppliedHash)) return res.status(403).json({ error: "Invalid bootstrap token." });
  const { username, password } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Username must be 3-20 characters (letters, numbers, _)." });
  if (!password || password.length < 12) return res.status(400).json({ error: "Bootstrap password must be at least 12 characters." });
  const passwordHash = await bcrypt.hash(password, 10);
  let userId;
  try {
    userId = db.transaction(() => {
      const consumed = db.prepare("SELECT value FROM app_settings WHERE key='bootstrap_admin_consumed'").get();
      const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
      if (consumed || userCount !== 0) throw Object.assign(new Error("Bootstrap is permanently unavailable."), { status: 409 });
      const id = Number(db.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,'admin')").run(username, passwordHash).lastInsertRowid);
      db.prepare("INSERT INTO app_settings (key,value) VALUES ('bootstrap_admin_consumed','1')").run();
      return id;
    })();
  } catch (error) {
    const status = error.status || (String(error.message).includes("UNIQUE") ? 409 : 500);
    return res.status(status).json({ error: error.status ? error.message : "Bootstrap failed." });
  }
  const { token, csrfToken } = createSession(userId, { ip: req.ip, userAgent: req.headers["user-agent"] || null });
  setSessionCookie(res, token);
  return res.json({ csrf_token: csrfToken, user: { id: userId, username, role: "admin" } });
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username || "");

  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "Wrong username or password." });
  }

  if (user.status === "disabled") {
    return res.status(403).json({ error: "This account is disabled." });
  }
  if (IS_HOSTED && user.email_normalized && !user.email_verified_at) {
    return res.status(403).json({ error: "Verify your email before signing in." });
  }

  if (user.mfa_enabled_at && user.totp_secret_encrypted) {
    const challenge = issueLoginChallenge(user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null,
    });
    return res.status(202).json({ mfa_required: true, ...challenge });
  }

  const { token, csrfToken } = createSession(user.id, {
    ip: req.ip,
    userAgent: req.headers["user-agent"] || null,
  });
  setSessionCookie(res, token);
  return res.json({ csrf_token: csrfToken, user: userDto(user) });
});

function userDto(user) {
  return {
    id: user.id ?? user.user_id,
    username: user.username,
    role: user.role,
    email: user.email || null,
    email_verified: !!user.email_verified_at,
    mfa_enabled: !!user.mfa_enabled_at,
  };
}

authRouter.post("/mfa/challenge", mfaChallengeLimiter, (req, res) => {
  const result = verifyLoginChallenge({
    token: req.body?.challenge_token,
    code: req.body?.code,
    onVerified: (challenge) => {
      const session = createSession(challenge.user_id, {
        ip: req.ip,
        userAgent: req.headers["user-agent"] || null,
      });
      return { challenge, session };
    },
  });
  if (!result) return res.status(401).json({ error: "Invalid or expired MFA challenge or code." });
  setSessionCookie(res, result.session.token);
  return res.json({ csrf_token: result.session.csrfToken, user: userDto(result.challenge) });
});

authRouter.get("/mfa/status", requireAuth, (req, res) => res.json(mfaStatus(req.user.id)));

authRouter.post("/mfa/setup/begin", mfaAccountLimiter, requireAuth, requireCsrf, (req, res) => {
  if (req.user.mfaEnabled) return res.status(409).json({ error: "MFA is already enabled." });
  return res.json(beginTotpSetup(req.user));
});

authRouter.post("/mfa/setup/confirm", mfaAccountLimiter, requireAuth, requireCsrf, (req, res) => {
  const result = confirmTotpSetup(req.user.id, req.body?.code, { currentSessionHash: req.sessionData.tokenHash });
  if (!result) return res.status(400).json({ error: "Enter a valid current authenticator code." });
  return res.json(result);
});

authRouter.post("/mfa/recovery/regenerate", mfaAccountLimiter, requireAuth, requireCsrf, async (req, res) => {
  const user = db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id);
  if (!user || !(await bcrypt.compare(String(req.body?.password || ""), user.password_hash))) {
    return res.status(401).json({ error: "Password or MFA code is incorrect." });
  }
  const recoveryCodes = regenerateRecoveryCodes(req.user.id, req.body?.code);
  if (!recoveryCodes) return res.status(401).json({ error: "Password or MFA code is incorrect." });
  return res.json({ recovery_codes: recoveryCodes });
});

authRouter.post("/mfa/disable", mfaAccountLimiter, requireAuth, requireCsrf, async (req, res, next) => {
  const user = db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id);
  if (!user || !(await bcrypt.compare(String(req.body?.password || ""), user.password_hash))) {
    return res.status(401).json({ error: "Password or MFA code is incorrect." });
  }
  try {
    const disabled = disableMfa(req.user.id, { code: req.body?.code, currentSessionHash: req.sessionData.tokenHash });
    if (!disabled) return res.status(401).json({ error: "Password or MFA code is incorrect." });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

authRouter.get("/sessions", requireAuth, (req, res) => {
  const sessions = db.prepare(`SELECT public_id,created_at,last_seen_at,expires_at,user_agent,ip,token_hash
    FROM sessions WHERE user_id=?
      AND julianday(expires_at)>julianday('now')
      AND COALESCE(last_seen_at,created_at)>datetime('now','-7 days')
    ORDER BY created_at DESC,rowid DESC`).all(req.user.id).map((session) => ({
      id: session.public_id,
      current: session.token_hash === req.sessionData.tokenHash,
      created_at: session.created_at,
      last_seen_at: session.last_seen_at,
      expires_at: session.expires_at,
      user_agent: session.user_agent,
      ip: session.ip,
    }));
  return res.json({ sessions });
});

authRouter.post("/sessions/revoke-others", requireAuth, requireCsrf, (req, res) => {
  const result = db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(req.user.id, req.sessionData.tokenHash);
  return res.json({ ok: true, revoked: result.changes });
});

authRouter.post("/sessions/:id/revoke", requireAuth, requireCsrf, (req, res) => {
  const session = db.prepare("SELECT token_hash FROM sessions WHERE public_id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.token_hash === req.sessionData.tokenHash) return res.status(409).json({ error: "Sign out to end the current session." });
  db.prepare("DELETE FROM sessions WHERE public_id=? AND user_id=?").run(req.params.id, req.user.id);
  return res.json({ ok: true });
});

authRouter.post("/logout", requireAuth, requireCsrf, (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (token) {
    deleteSession(sessionTokenHash(token));
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Returns current user + fresh CSRF token for session hydration on page load.
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({
    csrf_token: req.sessionData.csrfToken,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      email: req.user.email,
      email_verified: req.user.emailVerified,
      mfa_enabled: req.user.mfaEnabled,
    },
  });
});

// ---------------------------------------------------------------------------
// Middleware: requireAuth
// ---------------------------------------------------------------------------

export function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Sign in to continue." });

  const tokenHash = sessionTokenHash(token);
  const session = db
    .prepare(
      `SELECT s.token_hash, s.csrf_token, s.expires_at, s.last_seen_at,
              u.id, u.username, u.role, u.status, u.email, u.email_verified_at, u.mfa_enabled_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND julianday(s.expires_at) > julianday('now')
         AND COALESCE(s.last_seen_at,s.created_at) > datetime('now', '-7 days')`
    )
    .get(tokenHash);

  if (!session) {
    deleteSession(tokenHash);
    clearSessionCookie(res);
    return res.status(401).json({ error: "Session expired. Sign in again." });
  }
  if (session.status === "disabled") {
    deleteSession(tokenHash);
    clearSessionCookie(res);
    return res.status(403).json({ error: "This account is disabled." });
  }
  db.prepare("UPDATE sessions SET last_seen_at=datetime('now') WHERE token_hash=? AND COALESCE(last_seen_at,created_at) < datetime('now','-5 minutes')").run(tokenHash);

  req.user = {
    id: session.id,
    username: session.username,
    role: session.role,
    status: session.status,
    email: session.email || null,
    emailVerified: !!session.email_verified_at,
    mfaEnabled: !!session.mfa_enabled_at,
  };
  req.sessionData = {
    tokenHash: session.token_hash,
    csrfToken: session.csrf_token,
  };
  next();
}

export function requireVerifiedEmail(req, res, next) {
  if (!IS_HOSTED) return next();
  if (!req.user?.emailVerified) {
    return res.status(403).json({ error: "Verify an email address before connecting providers or importing history." });
  }
  next();
}

// ---------------------------------------------------------------------------
// Middleware: requireCsrf  (apply after requireAuth on mutating routes)
// ---------------------------------------------------------------------------

export function requireCsrf(req, res, next) {
  const csrfToken = req.headers["x-csrf-token"];
  if (!csrfToken || csrfToken !== req.sessionData?.csrfToken) {
    return res.status(403).json({ error: "Invalid or missing CSRF token." });
  }
  next();
}

// ---------------------------------------------------------------------------
// Middleware: requireAdmin
// ---------------------------------------------------------------------------

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  if (IS_HOSTED && !req.user.mfaEnabled) {
    return res.status(403).json({ error: "Enable MFA before using administrator features." });
  }
  next();
}
