import { Router } from "express";
import { db } from "../db.js";
import { requireAdmin, requireCsrf, randomHex, sha256, deleteUserSessions } from "../auth.js";
import { applyPlaceholderReconciliation, previewPlaceholderReconciliation } from "../sync.js";

export const admin = Router();

// Admin routes require CSRF on mutations.
admin.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return requireCsrf(req, res, next);
  }
  next();
});

admin.use(requireAdmin);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function safeUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    public_profile: !!u.public_profile,
    created_at: u.created_at,
    // Provider link presence (not tokens/secrets).
    linked_services: u.linked_services || [],
  };
}

function isLastAdmin(id) {
  const target = db.prepare("SELECT role FROM users WHERE id = ?").get(id);
  if (target?.role !== "admin") return false;
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND status = 'active'").get().c <= 1;
}

admin.get("/users", (req, res) => {
  const q = (req.query.q || "").toString().trim();
  let users;
  if (q) {
    users = db
      .prepare(
        `SELECT u.*, GROUP_CONCAT(c.service) linked_services_raw
         FROM users u LEFT JOIN connections c ON c.user_id = u.id
         WHERE u.username LIKE ? COLLATE NOCASE
         GROUP BY u.id ORDER BY u.id LIMIT 50`
      )
      .all(`%${q}%`);
  } else {
    users = db
      .prepare(
        `SELECT u.*, GROUP_CONCAT(c.service) linked_services_raw
         FROM users u LEFT JOIN connections c ON c.user_id = u.id
         GROUP BY u.id ORDER BY u.id LIMIT 50`
      )
      .all();
  }
  res.json({
    users: users.map((u) => {
      const base = safeUser(u);
      base.linked_services = u.linked_services_raw
        ? u.linked_services_raw.split(",")
        : [];
      return base;
    }),
  });
});

admin.get("/users/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid user id." });
  const u = db
    .prepare(
      `SELECT u.*, GROUP_CONCAT(c.service) linked_services_raw
       FROM users u LEFT JOIN connections c ON c.user_id = u.id
       WHERE u.id = ? GROUP BY u.id`
    )
    .get(id);
  if (!u) return res.status(404).json({ error: "User not found." });
  const base = safeUser(u);
  base.linked_services = u.linked_services_raw
    ? u.linked_services_raw.split(",")
    : [];
  res.json({ user: base });
});

admin.post("/users/:id/role", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid user id." });
  const role = (req.body?.role || "").toString();
  if (!["user", "admin"].includes(role)) {
    return res.status(400).json({ error: "role must be 'user' or 'admin'." });
  }
  const u = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!u) return res.status(404).json({ error: "User not found." });
  if (id === req.user.id && role !== "admin") {
    return res.status(409).json({ error: "You cannot remove your own admin role." });
  }
  if (role !== "admin" && isLastAdmin(id)) {
    return res.status(409).json({ error: "At least one active admin is required." });
  }

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  db.prepare(
    `INSERT INTO audit_log (user_id, action, target_id, detail, ip)
     VALUES (?, 'set_role', ?, ?, ?)`
  ).run(req.user.id, id, role, req.ip);
  res.json({ ok: true });
});

admin.post("/users/:id/status", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid user id." });
  const status = (req.body?.status || "").toString();
  if (!["active", "disabled"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'disabled'." });
  }
  const u = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!u) return res.status(404).json({ error: "User not found." });
  if (id === req.user.id && status === "disabled") {
    return res.status(409).json({ error: "You cannot disable your own account." });
  }
  if (status === "disabled" && isLastAdmin(id)) {
    return res.status(409).json({ error: "At least one active admin is required." });
  }

  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);

  // Revoke all sessions immediately on disable.
  if (status === "disabled") {
    deleteUserSessions(id);
  }

  db.prepare(
    `INSERT INTO audit_log (user_id, action, target_id, detail, ip)
     VALUES (?, 'set_status', ?, ?, ?)`
  ).run(req.user.id, id, status, req.ip);
  res.json({ ok: true });
});

// Revoke a specific session by token hash (admin visible from session list).
admin.post("/users/:id/sessions/revoke", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid user id." });

  const tokenHash = (req.body?.token_hash || "").toString();
  if (!tokenHash) {
    // Revoke all sessions for the user.
    deleteUserSessions(id);
  } else {
    db.prepare(
      "DELETE FROM sessions WHERE token_hash = ? AND user_id = ?"
    ).run(tokenHash, id);
  }

  db.prepare(
    `INSERT INTO audit_log (user_id, action, target_id, detail, ip)
     VALUES (?, 'revoke_sessions', ?, ?, ?)`
  ).run(req.user.id, id, tokenHash || "all", req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

admin.post("/invites", (req, res) => {
  const email = (req.body?.email || null);
  const code = randomHex(24); // 48-char hex, never stored in plain
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO invites (token_hash, created_by, email, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(codeHash, req.user.id, email, expiresAt);

  db.prepare(
    `INSERT INTO audit_log (user_id, action, detail, ip)
     VALUES (?, 'create_invite', ?, ?)`
  ).run(req.user.id, email || "no-email", req.ip);

  res.json({ invite_code: code, expires_at: expiresAt });
});

admin.get("/invites", (_req, res) => {
  const invites = db
    .prepare(
      `SELECT i.id, i.email, i.expires_at, i.revoked, i.created_at,
              i.used_at, i.used_by,
              c.username created_by_name,
              u.username used_by_name
       FROM invites i
       JOIN users c ON c.id = i.created_by
       LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC LIMIT 200`
    )
    .all();
  // Never return token_hash — admin only needs metadata.
  res.json({ invites });
});

admin.post("/invites/:id/revoke", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid invite id." });
  const inv = db.prepare("SELECT id FROM invites WHERE id = ?").get(id);
  if (!inv) return res.status(404).json({ error: "Invite not found." });
  db.prepare("UPDATE invites SET revoked = 1 WHERE id = ?").run(id);
  db.prepare(
    `INSERT INTO audit_log (user_id, action, target_id, ip)
     VALUES (?, 'revoke_invite', ?, ?)`
  ).run(req.user.id, id, req.ip);
  res.json({ ok: true });
});

// Explicit, one-use onboarding placeholder reconciliation. Preview is read-only;
// apply accepts only IDs from the exact, still-current preview snapshot.
admin.post("/users/:id/reconciliation/preview", (req, res, next) => {
  const targetUserId = parseInt(req.params.id, 10);
  if (!targetUserId || !db.prepare("SELECT id FROM users WHERE id=?").get(targetUserId)) return res.status(404).json({ error: "User not found." });
  try {
    res.set("Cache-Control", "no-store").json(previewPlaceholderReconciliation(req.user.id, targetUserId, req.body?.placeholder_date));
  } catch (error) { next(error); }
});

admin.post("/users/:id/reconciliation/apply", (req, res, next) => {
  const targetUserId = parseInt(req.params.id, 10);
  if (!targetUserId || !db.prepare("SELECT id FROM users WHERE id=?").get(targetUserId)) return res.status(404).json({ error: "User not found." });
  try {
    const result = applyPlaceholderReconciliation(req.user.id, targetUserId, {
      nonce: req.body?.nonce,
      previewHash: req.body?.preview_hash,
      candidateIds: req.body?.candidate_ids,
      ip: req.ip,
    });
    res.set("Cache-Control", "no-store").json(result);
  } catch (error) { next(error); }
});
