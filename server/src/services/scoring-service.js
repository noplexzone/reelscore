import { db } from "../db.js";
import { evaluateWatchEligibility, ELIGIBILITY_RULE_VERSION } from "../eligibility.js";
import { basePoints } from "../scoring.js";
import { localDay, normalizeUtcInstant } from "../time.js";
import { awardScoreEvent, reverseScoreEvents } from "../repositories/score-ledger.js";
import { reconcileSeasonScoresForUser } from "./season-scoring-service.js";

const WATCH_CATEGORIES = ["watch_first", "watch_cooldown", "watch_rewatch"];
const SEASON_RECONCILIATION_CHUNK = 100;
function chunks(values, size = SEASON_RECONCILIATION_CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function desiredAward(watch, decision) {
  if (watch.deleted_at != null || ["duplicate_pending", "duplicate_keep_separate"].includes(decision.eligibility_reason)) return null;
  const base = basePoints({ voteAverage: watch.vote_average, runtime: watch.runtime });
  let category;
  let multiplier;
  if (decision.eligibility_reason === "canonical_first_watch") {
    category = "watch_first";
    multiplier = 1;
  } else if (decision.eligibility_reason === "rewatch_outside_cooldown") {
    category = "watch_rewatch";
    multiplier = 0.25;
  } else {
    category = "watch_cooldown";
    multiplier = 0;
  }
  const points = Math.round(base * multiplier);
  return {
    category,
    points,
    metadata: {
      category,
      title: watch.title,
      tmdb_id: watch.tmdb_id,
      inputs: { vote_average: watch.vote_average, runtime: watch.runtime },
      calculation: {
        formula: "round(base_points * multiplier)",
        base_points: base,
        multiplier,
        awarded_points: points,
      },
      reason: decision.eligibility_reason,
      watched_at_utc: watch.watched_at_utc,
      source: watch.source,
      logical_canonical_watch_id: decision.logical_canonical_watch_id,
    },
  };
}

function reconcileOneMovie(userId, tmdbId) {
  const timezone = db.prepare("SELECT timezone FROM users WHERE id=?").get(userId)?.timezone || "UTC";
  const incomplete = db.prepare(`SELECT id,watched_at,watched_at_utc,timezone_used FROM watches
    WHERE user_id=? AND tmdb_id=? AND (watched_at_utc IS NULL OR watched_day_local IS NULL OR timezone_used IS NULL)`).all(userId, tmdbId);
  const normalize = db.prepare("UPDATE watches SET watched_at_utc=?,watched_day_local=?,timezone_used=? WHERE id=?");
  for (const watch of incomplete) {
    const instant = normalizeUtcInstant(watch.watched_at_utc || watch.watched_at);
    const zone = watch.timezone_used || timezone;
    normalize.run(instant, localDay(instant, zone), zone, watch.id);
  }
  const watches = db.prepare(`SELECT w.*,
      CASE
        WHEN EXISTS(SELECT 1 FROM duplicate_cases d WHERE d.candidate_watch_id=w.id AND d.status='pending') THEN 'pending'
        WHEN EXISTS(SELECT 1 FROM duplicate_cases d WHERE d.candidate_watch_id=w.id AND d.status='resolved' AND d.resolution='keep_separate' AND d.cancelled_at IS NULL) THEN 'excluded'
        ELSE NULL END duplicate_status
    FROM watches w WHERE w.user_id=? AND w.tmdb_id=? ORDER BY w.watched_at_utc,w.id`).all(userId, tmdbId);
  if (watches.length === 0) return [];
  const decisions = evaluateWatchEligibility(watches);
  const byId = new Map(watches.map((watch) => [watch.id, watch]));
  const updateEligibility = db.prepare(`UPDATE watches SET logical_canonical_watch_id=?,qualifies_for_volume=?,
    qualifies_for_achievement=?,qualifies_for_streak=?,qualifies_for_season=?,eligibility_status='evaluated',
    eligibility_rule_version=?,eligibility_reason=? WHERE id=? AND user_id=?`);
  const updateProjection = db.prepare("UPDATE watches SET points=?,is_rewatch=? WHERE id=? AND user_id=?");
  const results = [];

  for (const decision of decisions) {
    const watch = byId.get(decision.id);
    updateEligibility.run(decision.logical_canonical_watch_id, decision.qualifies_for_volume,
      decision.qualifies_for_achievement, decision.qualifies_for_streak, decision.qualifies_for_season,
      decision.eligibility_rule_version, decision.eligibility_reason, watch.id, userId);
    const desired = desiredAward(watch, decision);
    const active = db.prepare(`SELECT * FROM score_events WHERE user_id=? AND watch_id=?
      AND reverses_event_id IS NULL AND reversed_at IS NULL
      AND ((rule_version=? AND category IN (${WATCH_CATEGORIES.map(() => "?").join(",")}))
        OR (rule_version='legacy-v1' AND category='legacy_watch')) ORDER BY id`)
      .all(userId, watch.id, ELIGIBILITY_RULE_VERSION, ...WATCH_CATEGORIES);
    const eligibilityChanged = watch.logical_canonical_watch_id !== decision.logical_canonical_watch_id
      || watch.qualifies_for_volume !== decision.qualifies_for_volume
      || watch.qualifies_for_achievement !== decision.qualifies_for_achievement
      || watch.qualifies_for_streak !== decision.qualifies_for_streak
      || watch.qualifies_for_season !== decision.qualifies_for_season
      || desired == null;
    const preservingLegacy = desired && active.length === 1 && active[0].rule_version === "legacy-v1"
      && !eligibilityChanged;
    const matchingRuntime = desired && active.length === 1 && active[0].rule_version === ELIGIBILITY_RULE_VERSION
      && active[0].category === desired.category && active[0].points === desired.points;
    const matching = preservingLegacy || matchingRuntime;
    if (!matching && active.length) {
      reverseScoreEvents({ userId, eventIds: active.map((event) => event.id), reason: desired ? "watch_eligibility_changed" : (watch.deleted_reason || decision.eligibility_reason) });
    }

    let award = matching ? active[0] : null;
    if (desired && !award) {
      const generation = db.prepare(`SELECT COUNT(*) count FROM score_events WHERE watch_id=?
        AND category=? AND rule_version=? AND reverses_event_id IS NULL`).get(watch.id, desired.category, ELIGIBILITY_RULE_VERSION).count + 1;
      award = awardScoreEvent({
        eventKey: `watch/${watch.id}/${desired.category}/${generation}`,
        userId,
        watchId: watch.id,
        category: desired.category,
        points: desired.points,
        ruleVersion: ELIGIBILITY_RULE_VERSION,
        metadata: desired.metadata,
        effectiveAt: watch.watched_at_utc,
      });
    }
    if (!preservingLegacy) {
      updateProjection.run(desired?.points ?? 0, desired?.category === "watch_first" ? 0 : 1, watch.id, userId);
    }
    results.push({ watchId: watch.id, decision, award });
  }
  return results;
}

export function reconcileMovieEligibility(userId, tmdbIds = null) {
  const ids = tmdbIds == null
    ? db.prepare("SELECT DISTINCT tmdb_id FROM watches WHERE user_id=?").all(userId).map((row) => row.tmdb_id)
    : [...new Set((Array.isArray(tmdbIds) ? tmdbIds : [tmdbIds]).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  return db.transaction(() => {
    const results = ids.flatMap((tmdbId) => reconcileOneMovie(userId, tmdbId));
    for (const chunk of chunks(ids)) reconcileSeasonScoresForUser(userId, { tmdbIds: chunk });
    return results;
  }).immediate();
}

export function scoreWatchEvent(watchId) {
  const watch = db.prepare("SELECT user_id,tmdb_id FROM watches WHERE id=?").get(watchId);
  if (!watch) throw new Error(`Watch ${watchId} was not found.`);
  return reconcileMovieEligibility(watch.user_id, [watch.tmdb_id]).find((result) => result.watchId === Number(watchId));
}
