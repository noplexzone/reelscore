import { db } from "../db.js";
import { normalizeUtcInstant } from "../time.js";

function positiveId(value, name, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer number.`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function metadataJson(metadata) {
  let value;
  try {
    value = JSON.stringify(metadata ?? {});
  } catch {
    throw new TypeError("metadata must be JSON-serializable.");
  }
  if (typeof value !== "string") throw new TypeError("metadata must be JSON-serializable.");
  return value;
}

function normalizedInput(input) {
  if (!input || typeof input !== "object") throw new TypeError("A score event input object is required.");
  const points = input.points;
  if (typeof points !== "number" || !Number.isInteger(points)) throw new TypeError("points must be an integer number.");
  return {
    event_key: requiredString(input.eventKey, "eventKey"),
    user_id: positiveId(input.userId, "userId"),
    watch_id: positiveId(input.watchId, "watchId", { optional: true }),
    achievement_id: positiveId(input.achievementId, "achievementId", { optional: true }),
    season_id: positiveId(input.seasonId, "seasonId", { optional: true }),
    projection_source_event_id: positiveId(input.projectionSourceEventId, "projectionSourceEventId", { optional: true }),
    season_member_id: positiveId(input.seasonMemberId, "seasonMemberId", { optional: true }),
    category: requiredString(input.category, "category"),
    points,
    rule_version: requiredString(input.ruleVersion, "ruleVersion"),
    metadata_json: metadataJson(input.metadata),
    created_at: input.createdAt == null ? null : normalizeUtcInstant(input.createdAt),
    effective_at: input.effectiveAt == null ? null : normalizeUtcInstant(input.effectiveAt),
    reverses_event_id: positiveId(input.reversesEventId, "reversesEventId", { optional: true }),
  };
}

function sameImmutableEvent(row, expected) {
  return ["event_key", "user_id", "watch_id", "achievement_id", "season_id", "projection_source_event_id", "season_member_id", "category", "points", "rule_version", "metadata_json", "created_at", "effective_at", "reverses_event_id"]
    .every((key) => row[key] === expected[key]);
}

export function awardScoreEvent(input) {
  const event = normalizedInput(input);
  const insertedCreatedAt = event.created_at ?? new Date().toISOString();
  const insertedEffectiveAt = event.effective_at ?? insertedCreatedAt;
  db.prepare(`INSERT INTO score_events
      (event_key,user_id,watch_id,achievement_id,season_id,projection_source_event_id,season_member_id,category,points,rule_version,metadata_json,created_at,effective_at,reverses_event_id)
      VALUES (@event_key,@user_id,@watch_id,@achievement_id,@season_id,@projection_source_event_id,@season_member_id,@category,@points,@rule_version,@metadata_json,@created_at,@effective_at,@reverses_event_id)
      ON CONFLICT(event_key) DO NOTHING`)
    .run({ ...event, created_at: insertedCreatedAt, effective_at: insertedEffectiveAt });
  const row = db.prepare("SELECT * FROM score_events WHERE event_key=?").get(event.event_key);
  const expected = { ...event, created_at: event.created_at ?? row?.created_at,
    effective_at: event.effective_at ?? event.created_at ?? row?.effective_at };
  if (!row || !sameImmutableEvent(row, expected)) {
    throw new Error(`Score event key conflict: ${event.event_key}`);
  }
  return row;
}

export function reverseScoreEvents({ userId, eventIds, reason, reversedAt = new Date() }) {
  const normalizedUserId = positiveId(userId, "userId");
  if (!Array.isArray(eventIds)) throw new TypeError("eventIds must be an array");
  const ids = eventIds.map((id) => positiveId(id, "eventId"));
  if (new Set(ids).size !== ids.length) throw new TypeError("eventIds must not contain duplicates.");
  const instant = normalizeUtcInstant(reversedAt);
  const normalizedReason = reason == null ? "reconciled" : requiredString(reason, "reason");
  const reverse = db.transaction(() => ids.map((id) => {
    const original = db.prepare(`SELECT * FROM score_events
      WHERE id=? AND user_id=? AND reverses_event_id IS NULL`).get(id, normalizedUserId);
    if (!original) throw new Error(`Score event ${id} was not found for this user.`);
    const existing = db.prepare("SELECT * FROM score_events WHERE reverses_event_id=?").get(id);
    if (existing) {
      if (original.reversed_at == null) throw new Error(`Score event ${id} has an incomplete reversal.`);
      return existing;
    }
    const changed = db.prepare("UPDATE score_events SET reversed_at=? WHERE id=? AND reversed_at IS NULL")
      .run(instant, id);
    if (changed.changes !== 1) throw new Error(`Score event ${id} reversal is incomplete.`);
    return awardScoreEvent({
      eventKey: `reverse/${original.event_key}`,
      userId: original.user_id,
      watchId: original.watch_id,
      achievementId: original.achievement_id,
      seasonId: original.season_id,
      projectionSourceEventId: original.projection_source_event_id,
      seasonMemberId: original.season_member_id,
      category: original.category,
      points: -original.points,
      ruleVersion: original.rule_version,
      metadata: {
        reason: normalizedReason,
        reverses_event_key: original.event_key,
        original_category: original.category,
        original_points: original.points,
      },
      createdAt: instant,
      effectiveAt: original.effective_at,
      reversesEventId: original.id,
    });
  }));
  return reverse();
}

export function totalScore(userId, { seasonId = null } = {}) {
  const uid = positiveId(userId, "userId");
  const sid = positiveId(seasonId, "seasonId", { optional: true });
  return db.prepare("SELECT COALESCE(SUM(points),0) points FROM score_events WHERE user_id=? AND season_id IS ?")
    .get(uid, sid).points;
}

export function scoreBreakdown(userId, { seasonId = null } = {}) {
  const uid = positiveId(userId, "userId");
  const sid = positiveId(seasonId, "seasonId", { optional: true });
  return db.prepare(`SELECT category,COALESCE(SUM(points),0) points FROM score_events
    WHERE user_id=? AND season_id IS ? GROUP BY category HAVING SUM(points)<>0 ORDER BY category`)
    .all(uid, sid);
}
