import { db } from "../db.js";
import { evaluateWatchEligibility } from "../eligibility.js";
import { localDay, normalizeUtcInstant } from "../time.js";
import { reconcileMovieEligibility } from "./scoring-service.js";
import { reconcileDuplicateStateForMovie } from "./duplicate-state-service.js";
import { prepareAchievementReconciliation, applyPreparedAchievementReconciliation } from "./achievement-service.js";

const FIELDS = new Set(["personal_rating", "review", "private_notes", "favorite", "tags", "venue", "visibility", "watched_at_utc"]);
const VISIBILITY = new Set(["private", "friends", "public"]);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (status, message) => Object.assign(new TypeError(message), { status });

function text(value, name, max) {
  if (value === null) return null;
  if (typeof value !== "string") throw fail(400, `${name} must be a string or null.`);
  const normalized = value.trim();
  if (normalized.length > max) throw fail(400, `${name} is too long.`);
  return normalized || null;
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "Diary update must be an object.");
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) throw fail(400, `Unknown diary field: ${key}.`);
  if (!Object.keys(input).length) throw fail(400, "Diary update must include a field.");
  const out = {};
  if (has(input, "personal_rating")) {
    const value = input.personal_rating;
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) throw fail(400, "personal_rating must be an integer from 0 to 100 or null.");
    out.personal_rating = value;
  }
  for (const [key, max] of [["review", 5000], ["private_notes", 10000], ["venue", 200]]) if (has(input, key)) out[key] = text(input[key], key, max);
  if (has(input, "favorite")) {
    if (typeof input.favorite !== "boolean") throw fail(400, "favorite must be a boolean.");
    out.favorite = input.favorite ? 1 : 0;
  }
  if (has(input, "visibility")) {
    if (typeof input.visibility !== "string" || !VISIBILITY.has(input.visibility)) throw fail(400, "visibility must be private, friends, or public.");
    out.visibility = input.visibility;
  }
  if (has(input, "tags")) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) throw fail(400, "tags must be an array of at most 20 values.");
    const tags = [];
    for (const raw of input.tags) {
      if (typeof raw !== "string") throw fail(400, "Each tag must be a string.");
      const tag = raw.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9 _-]{0,29}$/.test(tag)) throw fail(400, "Tags must be 1-30 normalized letters, numbers, spaces, underscores, or hyphens.");
      tags.push(tag);
    }
    out.tags = [...new Set(tags)].sort();
    out.tags_json = JSON.stringify(out.tags);
  }
  if (has(input, "watched_at_utc")) {
    if (typeof input.watched_at_utc !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.watched_at_utc)) throw fail(400, "watched_at_utc must be a canonical UTC instant.");
    try { out.watched_at_utc = normalizeUtcInstant(input.watched_at_utc); }
    catch { throw fail(400, "watched_at_utc must be a valid canonical UTC instant."); }
    if (out.watched_at_utc !== input.watched_at_utc) throw fail(400, "watched_at_utc must be canonical UTC.");
  }
  return out;
}

function dto(row) {
  let tags = [];
  try { tags = JSON.parse(row.tags_json || "[]"); } catch {}
  return { id: row.id, tmdb_id: row.tmdb_id, title: row.title, poster_path: row.poster_path,
    watched_at_utc: row.watched_at_utc, watched_day_local: row.watched_day_local, timezone_used: row.timezone_used,
    source: row.source, points: row.points, personal_rating: row.personal_rating, review: row.review,
    private_notes: row.private_notes, favorite: !!row.favorite, tags, venue: row.venue, visibility: row.visibility };
}

export function getDiaryEntry(userId, watchId) {
  const row = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=? AND deleted_at IS NULL").get(watchId, userId);
  if (!row) throw fail(404, "Watch entry not found.");
  return dto(row);
}

function hasProviderProofDependency(watch) {
  if (watch.source !== "manual" || watch.provider_service || watch.provider_connection_id || watch.provider_event_id) return true;
  return !!db.prepare(`SELECT 1 FROM watches p WHERE p.user_id=? AND p.logical_canonical_watch_id=?
      AND p.source<>'manual' AND p.provider_service IS NOT NULL AND p.provider_connection_id IS NOT NULL
      AND p.provider_event_id IS NOT NULL AND p.deleted_reason IN ('placeholder_reconciled','duplicate_merged')
    UNION ALL
    SELECT 1 FROM duplicate_cases d JOIN watches p ON p.id=d.candidate_watch_id
      WHERE d.user_id=? AND d.canonical_watch_id=? AND d.status='resolved' AND d.resolution='merge'
        AND d.cancelled_at IS NULL AND p.source<>'manual' AND p.provider_service IS NOT NULL
        AND p.provider_connection_id IS NOT NULL AND p.provider_event_id IS NOT NULL LIMIT 1`)
    .get(watch.user_id, watch.id, watch.user_id, watch.id);
}

function chronologyRows(userId, tmdbId) {
  return db.prepare(`SELECT w.*,CASE
      WHEN EXISTS(SELECT 1 FROM duplicate_cases d WHERE d.candidate_watch_id=w.id AND d.status='pending' AND d.cancelled_at IS NULL) THEN 'pending'
      WHEN EXISTS(SELECT 1 FROM duplicate_cases d WHERE d.candidate_watch_id=w.id AND d.status='resolved' AND d.resolution='keep_separate' AND d.cancelled_at IS NULL) THEN 'excluded'
      ELSE NULL END duplicate_status
    FROM watches w WHERE w.user_id=? AND w.tmdb_id=? ORDER BY w.watched_at_utc,w.id`).all(userId, tmdbId);
}

function decisionMap(rows) { return new Map(evaluateWatchEligibility(rows).map((decision) => [decision.id, decision])); }
function decisionChanged(before, after) {
  return !before || !after || ["logical_canonical_watch_id", "qualifies_for_volume", "qualifies_for_achievement", "qualifies_for_streak", "qualifies_for_season", "eligibility_reason"]
    .some((key) => before[key] !== after[key]);
}

function assertFrozenChronologyUnchanged(userId, watch, newAt) {
  const rows = chronologyRows(userId, watch.tmdb_id);
  const hypothetical = rows.map((row) => row.id === watch.id ? { ...row, watched_at_utc: newAt } : { ...row });
  hypothetical.sort((a, b) => a.watched_at_utc.localeCompare(b.watched_at_utc) || a.id - b.id);
  const oldDecisions = decisionMap(rows);
  const newDecisions = decisionMap(hypothetical);
  const affected = new Set([watch.id]);
  for (const row of rows) if (decisionChanged(oldDecisions.get(row.id), newDecisions.get(row.id))) affected.add(row.id);
  const zone = db.prepare("SELECT timezone FROM users WHERE id=?").get(userId)?.timezone || "UTC";
  const newDay = localDay(newAt, zone);
  for (const row of rows) {
    if (row.source !== "manual" && (row.watched_day_local === watch.watched_day_local || row.watched_day_local === newDay)) affected.add(row.id);
  }
  const ids = [...affected];
  const placeholders = ids.map(() => "?").join(",");
  const protectedSeason = db.prepare(`SELECT 1 FROM seasons s JOIN leagues l ON l.id=s.league_id
    JOIN season_members sm ON sm.season_id=s.id AND sm.user_id=?
    WHERE (s.finalized_at IS NOT NULL OR s.cancelled_at IS NOT NULL OR l.archived_at IS NOT NULL OR s.ends_at<=?)
      AND (EXISTS(SELECT 1 FROM score_events e WHERE e.season_id=s.id AND e.user_id=? AND e.watch_id IN (${placeholders}))
        OR EXISTS(SELECT 1 FROM watches w WHERE w.id IN (${placeholders}) AND w.user_id=?
          AND w.watched_at_utc>=s.starts_at AND w.watched_at_utc<s.ends_at
          AND w.watched_at_utc>=sm.eligible_from AND w.watched_at_utc<COALESCE(sm.eligible_until,s.ends_at))
        OR (? >= s.starts_at AND ? < s.ends_at AND ? >= sm.eligible_from AND ? < COALESCE(sm.eligible_until,s.ends_at)))
    LIMIT 1`).get(userId, new Date().toISOString(), userId, ...ids, ...ids, userId, newAt, newAt, newAt, newAt);
  if (protectedSeason) throw fail(409, "An ended, finalized, cancelled, or archived season would be affected.");
}

function actualChangedFields(current, update) {
  const changed = [];
  for (const key of ["personal_rating", "review", "private_notes", "favorite", "venue", "visibility"]) {
    if (has(update, key) && update[key] !== current[key]) changed.push(key);
  }
  if (has(update, "tags_json") && update.tags_json !== current.tags_json) changed.push("tags");
  if (has(update, "watched_at_utc") && update.watched_at_utc !== current.watched_at_utc) changed.push("watched_at_utc");
  return changed.sort();
}

export async function updateDiaryEntry(userId, watchId, input) {
  if (!Number.isInteger(watchId) || watchId <= 0) throw fail(400, "Invalid watch ID.");
  const update = validate(input);
  const before = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=? AND deleted_at IS NULL").get(watchId, userId);
  if (!before) throw fail(404, "Watch entry not found.");
  const requestedDateChange = has(update, "watched_at_utc") && update.watched_at_utc !== before.watched_at_utc;
  if (requestedDateChange) {
    if (hasProviderProofDependency(before)) throw fail(409, "Provider-attested watch dates are read-only.");
    assertFrozenChronologyUnchanged(userId, before, update.watched_at_utc);
  }
  const prepared = requestedDateChange
    ? await prepareAchievementReconciliation(userId, { collectionIds: before.collection_id ? [before.collection_id] : [] })
    : null;

  return db.transaction(() => {
    const current = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=? AND deleted_at IS NULL").get(watchId, userId);
    if (!current) throw fail(404, "Watch entry not found.");
    const changedFields = actualChangedFields(current, update);
    if (!changedFields.length) return dto(current);
    const dateChanged = changedFields.includes("watched_at_utc");
    if (dateChanged) {
      if (hasProviderProofDependency(current)) throw fail(409, "Provider-attested watch dates are read-only.");
      assertFrozenChronologyUnchanged(userId, current, update.watched_at_utc);
    }
    const sets = [], values = [];
    for (const key of ["personal_rating", "review", "private_notes", "favorite", "tags_json", "venue", "visibility"]) {
      if (changedFields.includes(key) || (key === "tags_json" && changedFields.includes("tags"))) {
        sets.push(`${key}=?`);
        values.push(key === "personal_rating" && update[key] !== null ? BigInt(update[key]) : update[key]);
      }
    }
    if (dateChanged) {
      const zone = db.prepare("SELECT timezone FROM users WHERE id=?").get(userId).timezone;
      sets.push("watched_at_utc=?", "watched_at=?", "watched_day_local=?", "timezone_used=?");
      values.push(update.watched_at_utc, update.watched_at_utc.replace("T", " ").replace(/\.\d{3}Z$/, ""), localDay(update.watched_at_utc, zone), zone);
    }
    db.prepare(`UPDATE watches SET ${sets.join(",")} WHERE id=? AND user_id=? AND deleted_at IS NULL`).run(...values, watchId, userId);
    if (dateChanged) {
      reconcileDuplicateStateForMovie(userId, current.tmdb_id);
      reconcileMovieEligibility(userId, [current.tmdb_id]);
      applyPreparedAchievementReconciliation(userId, prepared);
    }
    const after = db.prepare("SELECT * FROM watches WHERE id=?").get(watchId);
    db.prepare("INSERT INTO watch_annotation_audit(user_id,watch_id,changed_fields_json,before_json,after_json) VALUES (?,?,?,?,?)")
      .run(userId, watchId, JSON.stringify(changedFields), JSON.stringify(dto(current)), JSON.stringify(dto(after)));
    return dto(after);
  }).immediate();
}
