import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { JWT_SECRET } from "./config.js";

const loginRegisterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

export const authRouter = Router();

function issueToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: "30d",
  });
}

authRouter.post("/register", loginRegisterLimiter, async (req, res) => {
  const { username, password } = req.body || {};
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
  const user = { id: info.lastInsertRowid, username };
  res.json({ token: issueToken(user), user });
});

authRouter.post("/login", loginRegisterLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username || "");
  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  res.json({
    token: issueToken(user),
    user: { id: user.id, username: user.username },
  });
});

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Sign in again." });
  }
}
