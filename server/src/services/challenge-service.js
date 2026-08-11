import { db } from "../db.js";
import { awardScoreEvent } from "../repositories/score-ledger.js";

const DEF_KEYS = new Set(["slug", "title", "description", "points", "rule_version"]);
const ASSIGN_KEYS = new Set(["challenge_definition_id", "user_id"]);
const COMPLETE_KEYS = new Set(["evidence_note"]);

function httpError(status, message, ErrorType = Error) { return Object.assign(new ErrorType(message), { status }); }
function badRequest(message) { return httpError(400, message, TypeError); }
function notFound(message = "Challenge not found.") { return httpError(404, message, RangeError); }
function forbidden(message = "Challenge permission denied.") { return httpError(403, message); }
function conflict(message) { return httpError(409, message); }
function positiveId(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw badRequest(`${name} must be a positive integer number.`);
  return value;
}
function objectInput(value, name, allowed, { nonempty = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${name} must be an object.`);
  const keys = Object.keys(value);
  if (nonempty && keys.length === 0) throw badRequest(`${name} must not be empty.`);
  for (const key of keys) if (!allowed.has(key)) throw badRequest(`${name} contains an unsupported field.`);
  return value;
}
function text(value, name, maximum, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== "string") throw badRequest(`${name} must be a string.`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) throw badRequest(`${name} must contain between 1 and ${maximum} characters.`);
  return normalized || null;
}
function slug(value) {
  const normalized = text(value, "slug", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) throw badRequest("slug must contain only lowercase letters, numbers, underscores, or hyphens.");
  return normalized;
}
function json(value) { return JSON.stringify(value ?? {}); }
function canonicalNow() { return new Date().toISOString(); }
function activeAccess(userId, leagueId) {
  return db.prepare(`SELECT l.*,m.role stored_role FROM leagues l
    JOIN league_memberships m ON m.league_id=l.id AND m.user_id=? AND m.left_at IS NULL
    WHERE l.id=?`).get(userId, leagueId);
}
function requireMember(userId, leagueId) {
  const row = activeAccess(userId, leagueId);
  if (!row) throw notFound();
  return row;
}
function requireManager(userId, leagueId) {
  const row = requireMember(userId, leagueId);
  if (row.owner_user_id !== userId && row.stored_role !== "admin") throw forbidden();
  return row;
}
function requireMutableLeague(row) {
  if (row.archived_at !== null) throw conflict("Archived leagues are read-only.");
}
function seasonRow(seasonId) { return db.prepare("SELECT s.*,l.archived_at FROM seasons s JOIN leagues l ON l.id=s.league_id WHERE s.id=?").get(seasonId); }
function requireMutableChallengeSeason(actorId, leagueId, seasonId) {
  const access = requireManager(actorId, leagueId);
  requireMutableLeague(access);
  const season = seasonRow(seasonId);
  if (!season || season.league_id !== leagueId) throw notFound("Season not found.");
  if (season.mode !== "challenge") throw conflict("Challenge assignments require a challenge-mode season.");
  if (season.participants_locked_at === null) throw conflict("Challenge assignments require a locked participant snapshot.");
  if (season.cancelled_at !== null || season.finalized_at !== null || season.archived_at !== null) throw conflict("Frozen seasons cannot change challenge assignments.");
  return season;
}
function definitionDto(row) {
  return { id: row.id, league_id: row.league_id, slug: row.slug, title: row.title, description: row.description,
    points: row.points, rule_version: row.rule_version, archived_at: row.archived_at, created_at: row.created_at, updated_at: row.updated_at };
}
function assignmentDto(row) {
  return { id: row.id, season_id: row.season_id, challenge_definition_id: row.challenge_definition_id,
    user_id: row.user_id, username: row.username, slug: row.slug, title: row.title, description: row.description,
    points: row.points, status: row.status, assigned_at: row.assigned_at, completed_at: row.completed_at,
    cancelled_at: row.cancelled_at, evidence: row.evidence_json ? JSON.parse(row.evidence_json) : {} };
}
function assignmentDetail(id) {
  return db.prepare(`SELECT a.*,sm.user_id,sm.username_snapshot username,
      a.challenge_slug_snapshot slug,a.challenge_title_snapshot title,a.challenge_description_snapshot description,
      a.challenge_points_snapshot points,a.challenge_rule_version_snapshot rule_version
    FROM challenge_assignments a JOIN season_members sm ON sm.id=a.season_member_id WHERE a.id=?`).get(id);
}

export function createChallengeDefinition(actorId, leagueId, input) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId");
  const value = objectInput(input, "Challenge definition input", DEF_KEYS);
  const points = value.points;
  if (!Number.isSafeInteger(points) || points < 1 || points > 10000) throw badRequest("points must be an integer between 1 and 10000.");
  const row = db.transaction(() => {
    const access = requireManager(actor, lid); requireMutableLeague(access);
    const now = canonicalNow();
    const result = db.prepare(`INSERT INTO challenge_definitions
      (league_id,slug,title,description,points,rule_version,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(lid, slug(value.slug), text(value.title, "title", 100), text(value.description, "description", 1000, { required: false }), points,
        text(value.rule_version, "rule_version", 64), actor, now, now);
    return db.prepare("SELECT * FROM challenge_definitions WHERE id=?").get(Number(result.lastInsertRowid));
  }).immediate();
  return definitionDto(row);
}

export function listChallengeDefinitions(actorId, leagueId) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId");
  requireMember(actor, lid);
  return db.prepare("SELECT * FROM challenge_definitions WHERE league_id=? AND archived_at IS NULL ORDER BY lower(title),id").all(lid).map(definitionDto);
}

export function assignChallenge(actorId, leagueId, seasonId, input) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId"), sid = positiveId(seasonId, "seasonId");
  const value = objectInput(input, "Challenge assignment input", ASSIGN_KEYS);
  const definitionId = positiveId(value.challenge_definition_id, "challenge_definition_id");
  const userId = positiveId(value.user_id, "user_id");
  const row = db.transaction(() => {
    requireMutableChallengeSeason(actor, lid, sid);
    const definition = db.prepare("SELECT * FROM challenge_definitions WHERE id=? AND league_id=? AND archived_at IS NULL").get(definitionId, lid);
    if (!definition) throw notFound();
    const member = db.prepare("SELECT * FROM season_members WHERE season_id=? AND user_id=?").get(sid, userId);
    if (!member) throw notFound("Season participant not found.");
    const now = canonicalNow();
    const result = db.prepare(`INSERT INTO challenge_assignments
      (season_id,challenge_definition_id,season_member_id,assigned_by_user_id,challenge_slug_snapshot,
        challenge_title_snapshot,challenge_description_snapshot,challenge_points_snapshot,challenge_rule_version_snapshot,status,assigned_at,evidence_json)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?, '{}') ON CONFLICT(season_id,challenge_definition_id,season_member_id) DO NOTHING`)
      .run(sid, definitionId, member.id, actor, definition.slug, definition.title, definition.description, definition.points, definition.rule_version, now);
    const id = result.changes === 1 ? Number(result.lastInsertRowid)
      : db.prepare(`SELECT id FROM challenge_assignments WHERE season_id=? AND challenge_definition_id=? AND season_member_id=?`).get(sid, definitionId, member.id).id;
    return assignmentDetail(id);
  }).immediate();
  return assignmentDto(row);
}

export function completeChallenge(actorId, leagueId, seasonId, assignmentId, input = {}) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId"), sid = positiveId(seasonId, "seasonId"), aid = positiveId(assignmentId, "assignmentId");
  const value = objectInput(input, "Challenge completion input", COMPLETE_KEYS);
  const row = db.transaction(() => {
    const season = requireMutableChallengeSeason(actor, lid, sid);
    let assignment = assignmentDetail(aid);
    if (!assignment || assignment.season_id !== sid) throw notFound("Challenge assignment not found.");
    if (assignment.status === "completed") return assignment;
    if (assignment.status !== "pending") throw conflict("Only pending challenge assignments can be completed.");
    const completedAt = canonicalNow();
    const evidence = { note: text(value.evidence_note, "evidence_note", 1000, { required: false }), completed_by_user_id: actor };
    const event = awardScoreEvent({ eventKey: `season/${sid}/challenge-assignment/${aid}`, userId: assignment.user_id,
      seasonId: sid, seasonMemberId: assignment.season_member_id, category: "challenge_bonus", points: assignment.points,
      ruleVersion: assignment.rule_version, metadata: { challenge_definition_id: assignment.challenge_definition_id, assignment_id: aid, slug: assignment.slug },
      createdAt: completedAt, effectiveAt: completedAt });
    db.prepare(`UPDATE challenge_assignments SET status='completed',completed_at=?,score_event_id=?,evidence_json=?
      WHERE id=? AND status='pending'`).run(completedAt, event.id, json(evidence), aid);
    assignment = assignmentDetail(aid);
    if (assignment.score_event_id !== event.id || assignment.completed_at !== completedAt) throw new Error("Challenge completion failed to persist.");
    return assignment;
  }).immediate();
  return assignmentDto(row);
}

export function getChallengeDashboard(actorId, leagueId, seasonId) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId"), sid = positiveId(seasonId, "seasonId");
  requireMember(actor, lid);
  const season = seasonRow(sid);
  if (!season || season.league_id !== lid) throw notFound("Season not found.");
  const assignments = db.prepare(`SELECT a.*,sm.user_id,sm.username_snapshot username,
      a.challenge_slug_snapshot slug,a.challenge_title_snapshot title,a.challenge_description_snapshot description,
      a.challenge_points_snapshot points,a.challenge_rule_version_snapshot rule_version
    FROM challenge_assignments a JOIN season_members sm ON sm.id=a.season_member_id WHERE a.season_id=?
    ORDER BY lower(a.challenge_title_snapshot),lower(sm.username_snapshot),a.id`).all(sid).map(assignmentDto);
  const totals = { assigned: assignments.length, completed: assignments.filter((row) => row.status === "completed").length,
    pending: assignments.filter((row) => row.status === "pending").length };
  return { league_id: lid, season_id: sid, totals, assignments };
}
