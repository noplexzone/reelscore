import { db } from "../db.js";
import { reconcileSeasonBatch, reconcileSeasonFully } from "./season-scoring-service.js";
import { assertTimeZone, localDay, normalizeUtcInstant } from "../time.js";

const MODES = new Set(["casual", "verified", "challenge"]);
const CREATE_KEYS = new Set(["name", "start_date", "end_date", "mode", "rule_version"]);
const UPDATE_KEYS = CREATE_KEYS;
const OPTION_KEYS = new Set(["asOf"]);
const RECONCILE_KEYS = new Set(["afterUserId", "limit"]);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GRACE_MS = 72 * 60 * 60 * 1000;

function httpError(status, message, ErrorType = Error) { return Object.assign(new ErrorType(message), { status }); }
function badRequest(message) { return httpError(400, message, TypeError); }
function notFound() { return httpError(404, "Season not found.", RangeError); }
function forbidden() { return httpError(403, "Season permission denied."); }
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
function text(value, name, maximum) {
  if (typeof value !== "string") throw badRequest(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw badRequest(`${name} must contain between 1 and ${maximum} characters.`);
  return normalized;
}
function calendarDate(value, name) {
  if (typeof value !== "string") throw badRequest(`${name} must use YYYY-MM-DD.`);
  const match = value.match(DATE);
  if (!match) throw badRequest(`${name} must use YYYY-MM-DD.`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw badRequest(`${name} must be a valid calendar date.`);
  return value;
}
function canonicalAsOf(options = {}) {
  const value = objectInput(options, "Season options", OPTION_KEYS);
  if (value.asOf === undefined) return new Date().toISOString();
  try { return normalizeUtcInstant(value.asOf); }
  catch { throw badRequest("asOf must be a valid UTC instant."); }
}


function reconcileOptions(input = {}) {
  const value = objectInput(input, "Season reconcile options", RECONCILE_KEYS);
  if (value.afterUserId === null) throw badRequest("afterUserId must be omitted or a positive integer number.");
  const out = {};
  if (value.afterUserId !== undefined) out.afterUserId = positiveId(value.afterUserId, "afterUserId");
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100) throw badRequest("limit must be an integer between 1 and 100.");
    out.limit = value.limit;
  }
  return out;
}
function publicReconcileResult(result) {
  return {
    seasonId: result.seasonId, processed: result.processed ?? 0, failed: result.failed ?? 0,
    counts: result.counts ?? { added: result.added ?? 0, reversed: result.reversed ?? 0, reactivated: result.reactivated ?? 0 },
    nextCursor: result.nextCursor ?? null, done: !!result.done, frozen: !!result.frozen, ready: result.ready !== false,
  };
}
function auditSeasonReconcile(actor, seasonId, options, result, ip = null) {
  const detail = JSON.stringify({
    season_id: seasonId, after_user_id: options.afterUserId ?? null, limit: options.limit ?? null,
    processed: result.processed ?? 0, failed: result.failed ?? 0, next_cursor: result.nextCursor ?? null, done: !!result.done,
  });
  db.prepare("INSERT INTO audit_log(user_id,action,target_id,detail,ip) VALUES (?,'season.reconcile',?,?,?)")
    .run(actor, seasonId, detail, ip);
}

function localMidnight(date, timeZone) {
  assertTimeZone(timeZone);
  const [year, month, day] = date.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let candidate = wanted;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(({ type, value }) => [type, value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const adjustment = wanted - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(({ type, value }) => [type, value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== date || parts.hour !== "00" || parts.minute !== "00" || parts.second !== "00") {
    throw badRequest("Season boundary does not resolve to local midnight in the league timezone.");
  }
  return new Date(candidate).toISOString();
}
function seasonRow(id) { return db.prepare("SELECT * FROM seasons WHERE id=?").get(id); }
function activeAccess(userId, leagueId) {
  return db.prepare(`SELECT l.owner_user_id,l.archived_at,m.role FROM leagues l
    JOIN league_memberships m ON m.league_id=l.id AND m.user_id=? AND m.left_at IS NULL WHERE l.id=?`).get(userId, leagueId);
}
function requireMember(userId, leagueId) {
  const row = activeAccess(userId, leagueId); if (!row) throw notFound(); return row;
}
function requireManager(userId, leagueId) {
  const row = requireMember(userId, leagueId); if (row.owner_user_id !== userId && row.role !== "admin") throw forbidden(); return row;
}
function requireMutableLeague(access) {
  if (access.archived_at !== null) throw conflict("Archived leagues are read-only.");
}
function participantDtos(seasonId) {
  return db.prepare(`SELECT id,user_id,username_snapshot,eligible_from,eligible_until,created_at
    FROM season_members WHERE season_id=? ORDER BY lower(username_snapshot),user_id`).all(seasonId).map((row) => ({
    id: row.id, user_id: row.user_id, username: row.username_snapshot,
    eligible_from: row.eligible_from, eligible_until: row.eligible_until, created_at: row.created_at,
  }));
}
function derivedStatus(row, asOf) {
  if (row.cancelled_at !== null) return "cancelled";
  if (row.finalized_at !== null) return "finalized";
  if (asOf < row.starts_at) return "scheduled";
  if (asOf < row.ends_at) return "active";
  return "finalizing";
}
function seasonDto(row, asOf) {
  return {
    id: row.id, league_id: row.league_id, name: row.name, mode: row.mode, timezone: row.timezone,
    rule_version: row.rule_version, starts_at: row.starts_at, ends_at: row.ends_at,
    cancelled_at: row.cancelled_at, finalized_at: row.finalized_at,
    participants_locked_at: row.participants_locked_at, created_at: row.created_at, updated_at: row.updated_at,
    status: derivedStatus(row, asOf), participants: participantDtos(row.id),
  };
}
function translateWrite(error) {
  if (/overlap/i.test(error?.message || "")) throw conflict("Season dates overlap another non-cancelled season.");
  throw error;
}
function validateBounds(startDate, endDate, timezone, { future = true } = {}) {
  const start = calendarDate(startDate, "start_date"), end = calendarDate(endDate, "end_date");
  if (end <= start) throw badRequest("end_date must be after start_date.");
  if (future && start <= localDay(new Date(), timezone)) throw badRequest("start_date must be a future league-local date.");
  return { startsAt: localMidnight(start, timezone), endsAt: localMidnight(end, timezone) };
}

export function createSeason(actorId, leagueId, input) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId");
  const value = objectInput(input, "Season input", CREATE_KEYS);
  const name = text(value.name, "name", 100), rule = text(value.rule_version, "rule_version", 64);
  if (!MODES.has(value.mode)) throw badRequest("mode must be casual, verified, or challenge.");
  return db.transaction(() => {
    const access = requireManager(actor, lid);
    requireMutableLeague(access);
    const league = db.prepare("SELECT timezone FROM leagues WHERE id=?").get(lid);
    try { assertTimeZone(league.timezone); } catch { throw badRequest("League timezone must be a valid IANA timezone."); }
    const { startsAt, endsAt } = validateBounds(value.start_date, value.end_date, league.timezone);
    const now = new Date().toISOString();
    try {
      const result = db.prepare(`INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(lid, name, value.mode, league.timezone, rule, startsAt, endsAt, actor, now, now);
      return seasonDto(seasonRow(Number(result.lastInsertRowid)), now);
    } catch (error) { return translateWrite(error); }
  }).immediate();
}

export function updateScheduledSeason(actorId, seasonId, input) {
  const actor = positiveId(actorId, "actorId"), sid = positiveId(seasonId, "seasonId");
  const value = objectInput(input, "Season update", UPDATE_KEYS, { nonempty: true });
  return db.transaction(() => {
    const row = seasonRow(sid); if (!row) throw notFound(); requireMutableLeague(requireManager(actor, row.league_id));
    if (row.cancelled_at || row.finalized_at) throw conflict("Cancelled or finalized seasons are immutable.");
    const now = new Date().toISOString();
    if (row.participants_locked_at || now >= row.starts_at || db.prepare("SELECT 1 FROM season_members WHERE season_id=? LIMIT 1").get(sid)) throw conflict("Started seasons or seasons with a participant snapshot are immutable.");
    const name = value.name === undefined ? row.name : text(value.name, "name", 100);
    const mode = value.mode === undefined ? row.mode : value.mode;
    if (!MODES.has(mode)) throw badRequest("mode must be casual, verified, or challenge.");
    const rule = value.rule_version === undefined ? row.rule_version : text(value.rule_version, "rule_version", 64);
    const startDate = value.start_date === undefined ? localDay(row.starts_at, row.timezone) : value.start_date;
    const endDate = value.end_date === undefined ? localDay(row.ends_at, row.timezone) : value.end_date;
    const { startsAt, endsAt } = validateBounds(startDate, endDate, row.timezone);
    try {
      db.prepare("UPDATE seasons SET name=?,mode=?,rule_version=?,starts_at=?,ends_at=?,updated_at=? WHERE id=?")
        .run(name, mode, rule, startsAt, endsAt, now, sid);
    } catch (error) { translateWrite(error); }
    return seasonDto(seasonRow(sid), now);
  }).immediate();
}

export function cancelScheduledSeason(actorId, seasonId, options = {}) {
  const actor = positiveId(actorId, "actorId"), sid = positiveId(seasonId, "seasonId"), asOf = canonicalAsOf(options);
  return db.transaction(() => {
    const row = seasonRow(sid); if (!row) throw notFound(); requireMutableLeague(requireManager(actor, row.league_id));
    if (row.cancelled_at) return seasonDto(row, asOf);
    if (row.finalized_at) throw conflict("Finalized seasons cannot be cancelled.");
    if (asOf >= row.starts_at || row.participants_locked_at || db.prepare("SELECT 1 FROM season_members WHERE season_id=? LIMIT 1").get(sid)) throw conflict("A started season or season with a participant snapshot cannot be cancelled.");
    db.prepare("UPDATE seasons SET cancelled_at=?,updated_at=? WHERE id=? AND cancelled_at IS NULL").run(asOf, asOf, sid);
    return seasonDto(seasonRow(sid), asOf);
  }).immediate();
}

function materializeInTransaction(sid, asOf) {
  const row = seasonRow(sid); if (!row) throw notFound();
  const league = db.prepare("SELECT archived_at FROM leagues WHERE id=?").get(row.league_id);
  requireMutableLeague(league);
  if (row.cancelled_at) throw conflict("Cancelled seasons cannot be materialized.");
  if (asOf < row.starts_at) throw conflict("Season participant snapshots cannot be materialized before the start.");
  if (row.participants_locked_at) return seasonDto(row, asOf);
  const memberships = db.prepare(`SELECT m.id membership_id,m.user_id,m.left_at,u.username
    FROM league_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.league_id=? AND m.joined_at<? AND (m.left_at IS NULL OR m.left_at>?) ORDER BY m.id`).all(row.league_id, row.starts_at, row.starts_at);
  const insert = db.prepare(`INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from,eligible_until)
    VALUES (?,?,?,?,?,?)`);
  for (const member of memberships) {
    const cutoff = member.left_at === null ? null : (member.left_at < row.ends_at ? member.left_at : row.ends_at);
    insert.run(sid, member.membership_id, member.user_id, member.username, row.starts_at, cutoff);
  }
  db.prepare("UPDATE seasons SET participants_locked_at=?,updated_at=? WHERE id=? AND participants_locked_at IS NULL").run(asOf, asOf, sid);
  return seasonDto(seasonRow(sid), asOf);
}
export function materializeSeasonState(seasonId, options = {}) {
  const sid = positiveId(seasonId, "seasonId"), asOf = canonicalAsOf(options);
  return db.transaction(() => materializeInTransaction(sid, asOf)).immediate();
}
export function materializeSeasonForActor(actorId, seasonId, options = {}) {
  const actor = positiveId(actorId, "actorId"), sid = positiveId(seasonId, "seasonId"), asOf = canonicalAsOf(options);
  return db.transaction(() => { const row = seasonRow(sid); if (!row) throw notFound(); requireManager(actor, row.league_id); return materializeInTransaction(sid, asOf); }).immediate();
}

export function finalizeSeason(actorId, seasonId, options = {}) {
  const actor = positiveId(actorId, "actorId"), sid = positiveId(seasonId, "seasonId"), asOf = canonicalAsOf(options);
  return db.transaction(() => {
    let row = seasonRow(sid); if (!row) throw notFound(); requireManager(actor, row.league_id);
    if (row.finalized_at) return seasonDto(row, asOf);
    if (row.cancelled_at) throw conflict("Cancelled seasons cannot be finalized.");
    if (new Date(asOf).getTime() < new Date(row.ends_at).getTime() + GRACE_MS) throw conflict("Season finalization requires the full 72-hour grace period.");
    materializeInTransaction(sid, asOf); row = seasonRow(sid);
    const reconciled = reconcileSeasonFully(sid, { limit: 100 });
    if (reconciled.failed) throw conflict("Season finalization is unavailable until all score projections reconcile successfully.");
    const pending = db.prepare(`SELECT 1 FROM duplicate_cases d
      JOIN season_members sm ON sm.season_id=? AND sm.user_id=d.user_id
      LEFT JOIN watches canonical ON canonical.id=d.canonical_watch_id
      LEFT JOIN watches candidate ON candidate.id=d.candidate_watch_id
      WHERE d.status='pending' AND d.cancelled_at IS NULL AND julianday(d.created_at)<julianday(?) AND
        ((canonical.watched_at_utc>=sm.eligible_from AND canonical.watched_at_utc<COALESCE(sm.eligible_until,?)) OR
         (candidate.watched_at_utc>=sm.eligible_from AND candidate.watched_at_utc<COALESCE(sm.eligible_until,?))) LIMIT 1`)
      .get(sid, row.ends_at, row.ends_at, row.ends_at);
    if (pending) throw conflict("Pending duplicate review must be resolved before finalization.");
    db.prepare("UPDATE seasons SET finalized_at=?,updated_at=? WHERE id=? AND finalized_at IS NULL").run(asOf, asOf, sid);
    return seasonDto(seasonRow(sid), asOf);
  }).immediate();
}

export function listSeasons(userId, leagueId, options = {}) {
  const uid = positiveId(userId, "userId"), lid = positiveId(leagueId, "leagueId"), asOf = canonicalAsOf(options);
  if (!activeAccess(uid, lid)) return [];
  return db.prepare("SELECT * FROM seasons WHERE league_id=? ORDER BY starts_at DESC,id DESC").all(lid).map((row) => seasonDto(row, asOf));
}
export function getSeason(userId, seasonId, options = {}) {
  const uid = positiveId(userId, "userId"), sid = positiveId(seasonId, "seasonId"), asOf = canonicalAsOf(options);
  const row = seasonRow(sid); if (!row || !activeAccess(uid, row.league_id)) throw notFound(); return seasonDto(row, asOf);
}

export function reconcileSeasonForManager(actorId, leagueId, seasonId, input = {}, { ip = null } = {}) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId"), sid = positiveId(seasonId, "seasonId");
  const options = reconcileOptions(input);
  return db.transaction(() => {
    const row = seasonRow(sid);
    if (!row || row.league_id !== lid) throw notFound();
    requireMutableLeague(requireManager(actor, lid));
    let result;
    if (row.cancelled_at || row.finalized_at) {
      result = { seasonId: sid, processed: 0, failed: 0, counts: { added: 0, reversed: 0, reactivated: 0 }, nextCursor: null, done: true, frozen: true, ready: true };
    } else if (new Date().toISOString() < row.starts_at) {
      result = { seasonId: sid, processed: 0, failed: 0, counts: { added: 0, reversed: 0, reactivated: 0 }, nextCursor: null, done: true, frozen: false, ready: false };
    } else {
      result = reconcileSeasonBatch(sid, { ...options, enforcePostEndGrace: true });
    }
    auditSeasonReconcile(actor, sid, options, result, ip);
    return publicReconcileResult(result);
  }).immediate();
}
