import { createHmac, randomBytes } from "node:crypto";
import { db } from "../db.js";
import { SESSION_SECRET } from "../config.js";
import { assertTimeZone, normalizeUtcInstant } from "../time.js";

const MODES = new Set(["casual", "verified", "challenge"]);
const STORED_ROLES = new Set(["admin", "member"]);
const TOKEN_BYTES = 32;
const INVALID_INVITE_MESSAGE = "Invite is invalid or unavailable.";

function httpError(status, message, ErrorType = Error) {
  return Object.assign(new ErrorType(message), { status });
}
function badRequest(message) { return httpError(400, message, TypeError); }
function notFound(message = "League not found.") { return httpError(404, message, RangeError); }
function forbidden(message = "League permission denied.") { return httpError(403, message); }
function conflict(message) { return httpError(409, message); }
function invalidInvite() { return badRequest(INVALID_INVITE_MESSAGE); }

function positiveId(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${name} must be a positive integer number.`);
  }
  return value;
}
function objectInput(value, name, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw badRequest(`${name} contains an unsupported field.`);
  return value;
}
function boundedString(value, name, maximum, { trim = true } = {}) {
  if (typeof value !== "string") throw badRequest(`${name} must be a string.`);
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > maximum) throw badRequest(`${name} must contain between 1 and ${maximum} characters.`);
  return normalized;
}
function canonicalNow(epochMs = Date.now()) { return new Date(epochMs).toISOString(); }
function monotonicNow(after) {
  const now = Date.now();
  const lowerBound = after ? new Date(after).getTime() + 1 : now;
  return canonicalNow(Math.max(now, lowerBound));
}
function requireUser(userId) {
  if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(userId)) throw notFound("User not found.");
}

export function leagueInviteDigest(token, secret = SESSION_SECRET) {
  if (typeof token !== "string" || token.length < 32) throw new TypeError("League invite token is invalid.");
  if (typeof secret !== "string" || secret.length < 32) throw new Error("League invite secret is not configured safely.");
  return createHmac("sha256", secret)
    .update("reelscore-league-invite:v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

function activeAccess(userId, leagueId) {
  return db.prepare(`
    SELECT l.*, m.id membership_id, m.role stored_role, m.joined_at
    FROM leagues l
    JOIN league_memberships m ON m.league_id=l.id AND m.user_id=? AND m.left_at IS NULL
    WHERE l.id=?
  `).get(userId, leagueId);
}
function requireAccess(userId, leagueId) {
  const row = activeAccess(userId, leagueId);
  if (!row) throw notFound();
  return row;
}
function effectiveRole(row, userId) { return row.owner_user_id === userId ? "owner" : row.stored_role; }
function requireOwner(userId, leagueId) {
  const row = requireAccess(userId, leagueId);
  if (row.owner_user_id !== userId) throw forbidden("Only the league owner may perform this action.");
  return row;
}
function requireManager(userId, leagueId) {
  const row = requireAccess(userId, leagueId);
  if (row.owner_user_id !== userId && row.stored_role !== "admin") throw forbidden();
  return row;
}
function leagueDto(row, viewerId) {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    default_mode: row.default_mode,
    owner_user_id: row.owner_user_id,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    role: effectiveRole(row, viewerId),
  };
}
function memberDto(row, ownerUserId) {
  return {
    user_id: row.user_id,
    username: row.username,
    role: row.user_id === ownerUserId ? "owner" : row.role,
    joined_at: row.joined_at,
  };
}
function inviteDto(row) {
  return {
    id: row.id,
    league_id: row.league_id,
    created_by_user_id: row.created_by_user_id,
    max_uses: row.max_uses,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    role: "member",
  };
}
function loadInviteByToken(token) {
  let digest;
  try { digest = leagueInviteDigest(token); }
  catch { throw invalidInvite(); }
  const row = db.prepare(`
    SELECT i.*, l.name league_name, l.archived_at,
      (SELECT COUNT(*) FROM league_invite_uses u WHERE u.invite_id=i.id) uses
    FROM league_invites i JOIN leagues l ON l.id=i.league_id
    WHERE i.token_hash=?
  `).get(digest);
  if (!row) throw invalidInvite();
  return row;
}
function assertInviteAvailable(row, now) {
  if (row.revoked_at !== null || row.archived_at !== null || row.expires_at <= now || row.uses >= row.max_uses) throw invalidInvite();
}

export function createLeague(userId, input) {
  const uid = positiveId(userId, "userId");
  const value = objectInput(input, "League input", new Set(["name", "timezone", "default_mode"]));
  const name = boundedString(value.name, "name", 100);
  const timezone = boundedString(value.timezone, "timezone", 64, { trim: false });
  try { assertTimeZone(timezone); } catch { throw badRequest("timezone must be a valid IANA timezone."); }
  if (!MODES.has(value.default_mode)) throw badRequest("default_mode is invalid.");
  requireUser(uid);
  return db.transaction(() => {
    const now = canonicalNow();
    const result = db.prepare(`
      INSERT INTO leagues(name,timezone,default_mode,owner_user_id,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(name, timezone, value.default_mode, uid, uid, now, now);
    const leagueId = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at) VALUES (?,?,'member',?,?)")
      .run(leagueId, uid, now, now);
    return leagueDto(requireAccess(uid, leagueId), uid);
  }).immediate();
}

export function listLeagues(userId) {
  const uid = positiveId(userId, "userId");
  requireUser(uid);
  return db.prepare(`
    SELECT l.*, m.role stored_role
    FROM league_memberships m JOIN leagues l ON l.id=m.league_id
    WHERE m.user_id=? AND m.left_at IS NULL
    ORDER BY l.archived_at IS NOT NULL, lower(l.name), l.id
  `).all(uid).map((row) => leagueDto(row, uid));
}

export function getLeague(userId, leagueId) {
  const uid = positiveId(userId, "userId");
  const lid = positiveId(leagueId, "leagueId");
  const row = requireAccess(uid, lid);
  const members = db.prepare(`
    SELECT m.user_id, u.username, m.role, m.joined_at
    FROM league_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.league_id=? AND m.left_at IS NULL ORDER BY lower(u.username), m.user_id
  `).all(lid).map((member) => memberDto(member, row.owner_user_id));
  return { ...leagueDto(row, uid), members };
}

export function createInvite(actorId, leagueId, input) {
  const actor = positiveId(actorId, "actorId");
  const lid = positiveId(leagueId, "leagueId");
  const value = objectInput(input, "Invite input", new Set(["expires_at", "max_uses"]));
  if (typeof value.expires_at !== "string") throw badRequest("expires_at must be an explicit UTC instant string.");
  let expiresAt;
  try { expiresAt = normalizeUtcInstant(value.expires_at); } catch { throw badRequest("expires_at must be a valid instant."); }
  if (expiresAt <= canonicalNow()) throw badRequest("expires_at must be in the future.");
  if (!Number.isSafeInteger(value.max_uses) || value.max_uses < 1 || value.max_uses > 1000) throw badRequest("max_uses must be an integer between 1 and 1000.");
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const digest = leagueInviteDigest(token);
  return db.transaction(() => {
    const access = requireManager(actor, lid);
    if (access.archived_at !== null) throw conflict("Archived leagues cannot issue invites.");
    const now = canonicalNow();
    const result = db.prepare(`
      INSERT INTO league_invites(league_id,created_by_user_id,token_hash,max_uses,expires_at,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(lid, actor, digest, value.max_uses, expiresAt, now);
    const row = db.prepare("SELECT * FROM league_invites WHERE id=?").get(Number(result.lastInsertRowid));
    return { ...inviteDto(row), invite_path: `/join#invite=${encodeURIComponent(token)}` };
  }).immediate();
}

export function inspectInvite(token) {
  const row = loadInviteByToken(token);
  assertInviteAvailable(row, canonicalNow());
  return { league_name: row.league_name, expires_at: row.expires_at };
}

export function acceptInvite(userId, token) {
  const uid = positiveId(userId, "userId");
  requireUser(uid);
  let digest;
  try { digest = leagueInviteDigest(token); } catch { throw invalidInvite(); }
  return db.transaction(() => {
    const now = canonicalNow();
    const row = db.prepare(`
      SELECT i.*, l.name league_name, l.archived_at,
        (SELECT COUNT(*) FROM league_invite_uses u WHERE u.invite_id=i.id) uses
      FROM league_invites i JOIN leagues l ON l.id=i.league_id WHERE i.token_hash=?
    `).get(digest);
    if (!row || row.revoked_at !== null || row.archived_at !== null || row.expires_at <= now) throw invalidInvite();
    const active = db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(row.league_id, uid);
    if (active) return leagueDto(requireAccess(uid, row.league_id), uid);
    const priorUse = db.prepare("SELECT 1 FROM league_invite_uses WHERE invite_id=? AND user_id=?").get(row.id, uid);
    if (!priorUse && row.uses >= row.max_uses) throw invalidInvite();
    const previous = db.prepare("SELECT left_at FROM league_memberships WHERE league_id=? AND user_id=? ORDER BY id DESC LIMIT 1").get(row.league_id, uid);
    const joinedAt = previous?.left_at && previous.left_at >= now ? monotonicNow(previous.left_at) : now;
    const result = db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at) VALUES (?,?,'member',?,?)")
      .run(row.league_id, uid, joinedAt, now);
    if (!priorUse) {
      db.prepare("INSERT INTO league_invite_uses(invite_id,user_id,membership_id,used_at) VALUES (?,?,?,?)")
        .run(row.id, uid, Number(result.lastInsertRowid), joinedAt);
    }
    return leagueDto(requireAccess(uid, row.league_id), uid);
  }).immediate();
}

export function revokeInvite(actorId, inviteId) {
  const actor = positiveId(actorId, "actorId");
  const iid = positiveId(inviteId, "inviteId");
  return db.transaction(() => {
    const invite = db.prepare(`
      SELECT i.*, l.owner_user_id, m.role actor_role
      FROM league_invites i JOIN leagues l ON l.id=i.league_id
      JOIN league_memberships m ON m.league_id=l.id AND m.user_id=? AND m.left_at IS NULL
      WHERE i.id=?
    `).get(actor, iid);
    if (!invite) throw notFound("Invite not found.");
    if (invite.owner_user_id !== actor && invite.actor_role !== "admin") throw forbidden();
    if (invite.revoked_at === null) db.prepare("UPDATE league_invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(canonicalNow(), iid);
    return inviteDto(db.prepare("SELECT * FROM league_invites WHERE id=?").get(iid));
  }).immediate();
}

export function leaveLeague(userId, leagueId) {
  const uid = positiveId(userId, "userId");
  const lid = positiveId(leagueId, "leagueId");
  return db.transaction(() => {
    const league = db.prepare("SELECT owner_user_id FROM leagues WHERE id=?").get(lid);
    if (!league) throw notFound();
    if (league.owner_user_id === uid) throw conflict("Transfer ownership before leaving the league.");
    const active = db.prepare("SELECT id,joined_at FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(lid, uid);
    if (!active) {
      const prior = db.prepare("SELECT 1 FROM league_memberships WHERE league_id=? AND user_id=?").get(lid, uid);
      if (!prior) throw notFound();
      return { league_id: lid, left: false };
    }
    const leftAt = monotonicNow(active.joined_at);
    db.prepare(`
      UPDATE season_members
      SET eligible_until=?
      WHERE membership_id=? AND eligible_until IS NULL
        AND EXISTS (SELECT 1 FROM seasons s WHERE s.id=season_members.season_id
          AND s.starts_at<=? AND s.ends_at>? AND s.finalized_at IS NULL AND s.cancelled_at IS NULL)
    `).run(leftAt, active.id, leftAt, leftAt);
    db.prepare("UPDATE league_memberships SET left_at=? WHERE id=? AND left_at IS NULL").run(leftAt, active.id);
    return { league_id: lid, left: true, left_at: leftAt };
  }).immediate();
}

export function setMemberRole(actorId, leagueId, userId, role) {
  const actor = positiveId(actorId, "actorId");
  const lid = positiveId(leagueId, "leagueId");
  const target = positiveId(userId, "userId");
  if (!STORED_ROLES.has(role)) throw badRequest("role must be admin or member.");
  return db.transaction(() => {
    const league = requireOwner(actor, lid);
    if (target === league.owner_user_id) throw conflict("The owner role is derived and cannot be changed.");
    const member = db.prepare(`
      SELECT m.*, u.username FROM league_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.league_id=? AND m.user_id=? AND m.left_at IS NULL
    `).get(lid, target);
    if (!member) throw notFound("Active league member not found.");
    db.prepare("UPDATE league_memberships SET role=? WHERE id=?").run(role, member.id);
    return memberDto({ ...member, role }, league.owner_user_id);
  }).immediate();
}

export function transferOwnership(actorId, leagueId, newOwnerUserId) {
  const actor = positiveId(actorId, "actorId");
  const lid = positiveId(leagueId, "leagueId");
  const target = positiveId(newOwnerUserId, "newOwnerUserId");
  return db.transaction(() => {
    const league = requireOwner(actor, lid);
    if (target === actor) throw conflict("The user already owns this league.");
    if (!db.prepare("SELECT 1 FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(lid, target)) {
      throw notFound("Active league member not found.");
    }
    db.prepare("UPDATE league_memberships SET role='member' WHERE league_id=? AND user_id=? AND left_at IS NULL").run(lid, actor);
    db.prepare("UPDATE leagues SET owner_user_id=?, updated_at=? WHERE id=?").run(target, canonicalNow(), lid);
    return leagueDto(requireAccess(actor, lid), actor);
  }).immediate();
}

export function archiveLeague(actorId, leagueId) {
  const actor = positiveId(actorId, "actorId");
  const lid = positiveId(leagueId, "leagueId");
  return db.transaction(() => {
    const league = requireOwner(actor, lid);
    if (league.archived_at === null) {
      const now = canonicalNow();
      db.prepare("UPDATE leagues SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL").run(now, now, lid);
    }
    return leagueDto(requireAccess(actor, lid), actor);
  }).immediate();
}
