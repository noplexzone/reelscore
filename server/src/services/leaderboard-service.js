import { db } from "../db.js";
import { assertTimeZone } from "../time.js";

const SCOPES = new Set(["weekly", "monthly", "season", "lifetime"]);
const OPTION_KEYS = new Set(["scope", "weekStart", "month", "seasonId"]);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

function httpError(status, message, ErrorType = Error) { return Object.assign(new ErrorType(message), { status }); }
function badRequest(message) { return httpError(400, message, TypeError); }
function notFound(message = "Leaderboard not found.") { return httpError(404, message, RangeError); }
function positiveId(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw badRequest(`${name} must be a positive integer number.`);
  return value;
}
function objectInput(value, name, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw badRequest(`${name} contains an unsupported field.`);
  return value;
}
function parseDate(value, name) {
  if (typeof value !== "string") throw badRequest(`${name} must use YYYY-MM-DD.`);
  const match = value.match(DATE);
  if (!match) throw badRequest(`${name} must use YYYY-MM-DD.`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw badRequest(`${name} must be a valid calendar date.`);
  return { year, month, day, text: value };
}
function parseMonth(value) {
  if (typeof value !== "string") throw badRequest("month must use YYYY-MM.");
  const match = value.match(MONTH);
  if (!match) throw badRequest("month must use YYYY-MM.");
  const year = Number(match[1]), month = Number(match[2]);
  if (month < 1 || month > 12) throw badRequest("month must be a valid calendar month.");
  return { year, month, text: value };
}
function pad(value) { return String(value).padStart(2, "0"); }
function addDays(date, days) {
  const dt = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function addMonths(month, amount) {
  const dt = new Date(Date.UTC(month.year, month.month - 1 + amount, 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`;
}
function dayOfWeek(date) { return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay(); }
function localMidnight(dateText, timeZone) {
  assertTimeZone(timeZone);
  const { year, month, day } = parseDate(dateText, "date");
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
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
  if (`${parts.year}-${parts.month}-${parts.day}` !== dateText || parts.hour !== "00" || parts.minute !== "00" || parts.second !== "00") throw badRequest("Leaderboard period boundary does not resolve to local midnight in the league timezone.");
  return new Date(candidate).toISOString();
}
function activeAccess(userId, leagueId) {
  return db.prepare(`SELECT l.*,m.role stored_role FROM leagues l JOIN league_memberships m ON m.league_id=l.id AND m.user_id=? AND m.left_at IS NULL WHERE l.id=?`).get(userId, leagueId);
}
function requireAccess(userId, leagueId) {
  const row = activeAccess(userId, leagueId);
  if (!row) throw notFound();
  return row;
}
function rankEntries(rows) {
  let previousPoints = null, previousRank = 0;
  return rows.map((row, index) => {
    const points = Number(row.points ?? 0);
    const rank = previousPoints === points ? previousRank : index + 1;
    previousPoints = points; previousRank = rank;
    return { rank, user_id: row.user_id, username: row.username, points };
  });
}
function lifetimeEntries(leagueId, startsAt = null, endsAt = null) {
  const timeFilter = startsAt === null ? "" : "AND e.effective_at>=? AND e.effective_at<?";
  return db.prepare(`SELECT m.user_id,u.username,COALESCE(SUM(e.points),0) points FROM league_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN score_events e ON e.user_id=m.user_id AND e.season_id IS NULL ${timeFilter} WHERE m.league_id=? AND m.left_at IS NULL GROUP BY m.user_id,u.username ORDER BY points DESC, lower(u.username), m.user_id`).all(...(startsAt === null ? [leagueId] : [startsAt, endsAt, leagueId]));
}
function seasonEntries(seasonId) {
  return db.prepare(`SELECT sm.user_id,sm.username_snapshot username,COALESCE(SUM(e.points),0) points FROM season_members sm LEFT JOIN score_events e ON e.season_member_id=sm.id AND e.user_id=sm.user_id AND e.season_id=sm.season_id WHERE sm.season_id=? GROUP BY sm.id,sm.user_id,sm.username_snapshot ORDER BY points DESC, lower(sm.username_snapshot), sm.user_id`).all(seasonId);
}
export function listLeaderboard(actorId, leagueId, options = {}) {
  const actor = positiveId(actorId, "actorId"), lid = positiveId(leagueId, "leagueId");
  const value = objectInput(options, "Leaderboard options", OPTION_KEYS);
  const scope = value.scope;
  if (!SCOPES.has(scope)) throw badRequest("scope must be weekly, monthly, season, or lifetime.");
  const league = requireAccess(actor, lid);
  if (scope === "lifetime") {
    if (value.weekStart !== undefined || value.month !== undefined || value.seasonId !== undefined) throw badRequest("lifetime leaderboards do not accept period or season fields.");
    return { league_id: lid, scope, entries: rankEntries(lifetimeEntries(lid)) };
  }
  if (scope === "weekly") {
    if (value.month !== undefined || value.seasonId !== undefined) throw badRequest("weekly leaderboards accept only weekStart.");
    const week = parseDate(value.weekStart, "weekStart");
    if (dayOfWeek(week) !== 1) throw badRequest("weekStart must be a Monday.");
    const startsAt = localMidnight(week.text, league.timezone);
    const endsAt = localMidnight(addDays(week, 7), league.timezone);
    return { league_id: lid, scope, starts_at: startsAt, ends_at: endsAt, entries: rankEntries(lifetimeEntries(lid, startsAt, endsAt)) };
  }
  if (scope === "monthly") {
    if (value.weekStart !== undefined || value.seasonId !== undefined) throw badRequest("monthly leaderboards accept only month.");
    const month = parseMonth(value.month);
    const startsAt = localMidnight(`${month.text}-01`, league.timezone);
    const endsAt = localMidnight(`${addMonths(month, 1)}-01`, league.timezone);
    return { league_id: lid, scope, month: month.text, starts_at: startsAt, ends_at: endsAt, entries: rankEntries(lifetimeEntries(lid, startsAt, endsAt)) };
  }
  if (value.weekStart !== undefined || value.month !== undefined) throw badRequest("season leaderboards accept only seasonId.");
  const sid = positiveId(value.seasonId, "seasonId");
  const season = db.prepare("SELECT id,league_id,name,starts_at,ends_at,finalized_at FROM seasons WHERE id=?").get(sid);
  if (!season || season.league_id !== lid) throw notFound();
  return { league_id: lid, season_id: sid, scope, season: { id: season.id, name: season.name, starts_at: season.starts_at, ends_at: season.ends_at, finalized_at: season.finalized_at }, entries: rankEntries(seasonEntries(sid)) };
}
