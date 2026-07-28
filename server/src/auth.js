import bcrypt from "bcryptjs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { BOOTSTRAP_ADMIN_TOKEN, IS_HOSTED, REGISTRATION_MODE, SESSION_SECRET } from "./config.js";

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
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString().replace("T", " ").slice(0, 19);

  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, ip, user_agent, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(tokenHash, userId, csrfToken, expiresAt, ip, userAgent);
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

// ---------------------------------------------------------------------------
// Auth router
// ---------------------------------------------------------------------------

export const authRouter = Router();

authRouter.get("/config", (_req, res) => {
  res.json({
    app_mode: IS_HOSTED ? "hosted" : "self_hosted",
    registration_enabled: !IS_HOSTED && REGISTRATION_MODE !== "closed",
    registration_mode: REGISTRATION_MODE,
    plex_enabled: true,
    trakt_enabled: !!(process.env.TRAKT_CLIENT_ID && process.env.TRAKT_CLIENT_SECRET),
  });
});

authRouter.post("/register", authLimiter, async (req, res) => {
  if (IS_HOSTED || REGISTRATION_MODE === "closed") {
    return res.status(403).json({ error: "Public registration is disabled." });
  }

  const { username, password, invite_code } = req.body || {};

  if (REGISTRATION_MODE === "invite") {
    // Self-hosted invite mode (not the default, but configurable).
    if (!invite_code) {
      return res.status(403).json({ error: "An invite code is required to register." });
    }
    const codeHash = sha256(String(invite_code));
    const invite = db
      .prepare(
        `SELECT * FROM invites WHERE token_hash = ? AND revoked = 0
         AND used_by IS NULL AND julianday(expires_at) > julianday('now')`
      )
      .get(codeHash);
    if (!invite) {
      return res.status(403).json({ error: "Invalid or expired invite code." });
    }
  }

  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res
      .status(400)
      .json({ error: "Username must be 3-20 characters (letters, numbers, _)." });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (exists) return res.status(409).json({ error: "That username is taken." });

  const hash = await bcrypt.hash(password, 10);
  const info = db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run(username, hash);
  const userId = info.lastInsertRowid;

  // If no admin exists yet, make this user the first admin (fresh-install bootstrap).
  const adminCount = db
    .prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'")
    .get().c;
  if (adminCount === 0) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  }

  // Mark invite as used.
  if (REGISTRATION_MODE === "invite" && req.body?.invite_code) {
    const codeHash = sha256(String(req.body.invite_code));
    db.prepare(
      "UPDATE invites SET used_by = ?, used_at = datetime('now') WHERE token_hash = ?"
    ).run(userId, codeHash);
  }

  const { token, csrfToken } = createSession(userId, {
    ip: req.ip,
    userAgent: req.headers["user-agent"] || null,
  });
  setSessionCookie(res, token);
  res.json({
    csrf_token: csrfToken,
    user: { id: userId, username, role: "user" },
  });
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

  const { token, csrfToken } = createSession(user.id, {
    ip: req.ip,
    userAgent: req.headers["user-agent"] || null,
  });
  setSessionCookie(res, token);
  res.json({
    csrf_token: csrfToken,
    user: { id: user.id, username: user.username, role: user.role },
  });
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
    user: { id: req.user.id, username: req.user.username, role: req.user.role },
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
              u.id, u.username, u.role, u.status
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
  };
  req.sessionData = {
    tokenHash: session.token_hash,
    csrfToken: session.csrf_token,
  };
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
  next();
}
