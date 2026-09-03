import { normalizeUtcInstant } from "./time.js";

export const ELIGIBILITY_RULE_VERSION = "competitive-v1";
export const REWATCH_COOLDOWN_DAYS = 30;
const DAY_MS = 86_400_000;

function result(event, canonicalId, flags, reason) {
  return {
    id: event.id,
    logical_canonical_watch_id: canonicalId,
    qualifies_for_volume: flags.volume ? 1 : 0,
    qualifies_for_achievement: flags.achievement ? 1 : 0,
    qualifies_for_streak: flags.streak ? 1 : 0,
    qualifies_for_season: flags.season ? 1 : 0,
    eligibility_rule_version: ELIGIBILITY_RULE_VERSION,
    eligibility_reason: reason,
  };
}

export function evaluateWatchEligibility(events, { cooldownDays = REWATCH_COOLDOWN_DAYS } = {}) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  if (!Number.isFinite(cooldownDays) || cooldownDays < 0) throw new RangeError("cooldownDays must be non-negative");

  const chronological = events.map((event) => {
    let time;
    try {
      time = Date.parse(normalizeUtcInstant(event.watched_at_utc));
    } catch {
      throw new RangeError(`Invalid watched_at_utc for watch ${event.id}`);
    }
    return { ...event, __time: time };
  }).sort((a, b) => a.__time - b.__time || a.id - b.id);

  const state = new Map();
  return chronological.map((event) => {
    const key = `${event.user_id ?? "default"}:${event.tmdb_id}`;
    const prior = state.get(key);
    const canonicalId = prior?.canonicalId ?? event.logical_canonical_watch_id ?? event.id;
    const none = { volume: false, achievement: false, streak: false, season: false };

    if (event.competition_eligibility === "unverified_import") {
      return result(event, prior?.canonicalId ?? null, none, "unverified_import");
    }
    if (event.deleted_at != null) return result(event, canonicalId, none, "deleted");
    if (event.duplicate_status === "pending") return result(event, canonicalId, none, "duplicate_pending");
    if (event.duplicate_status === "excluded") return result(event, canonicalId, none, "duplicate_keep_separate");

    if (!prior) {
      state.set(key, { canonicalId: event.id, lastWatchTime: event.__time });
      return result(event, event.id, { volume: true, achievement: true, streak: true, season: true }, "canonical_first_watch");
    }

    const elapsed = event.__time - prior.lastWatchTime;
    prior.lastWatchTime = event.__time;
    if (elapsed < cooldownDays * DAY_MS) return result(event, prior.canonicalId, none, "rewatch_cooldown");
    return result(event, prior.canonicalId, { volume: false, achievement: false, streak: true, season: true }, "rewatch_outside_cooldown");
  });
}
