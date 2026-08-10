import { db } from "../db.js";
import { localDay, normalizeUtcInstant } from "../time.js";

function positiveId(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError("userId must be a positive integer number.");
  }
  return value;
}

function previousCalendarDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, date));
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10);
}

export function currentStreak(userId, { asOf = new Date() } = {}) {
  const uid = positiveId(userId);
  const instant = normalizeUtcInstant(asOf);
  const user = db.prepare("SELECT timezone FROM users WHERE id=?").get(uid);
  if (!user) throw new RangeError(`User ${uid} not found.`);

  const days = new Set(db.prepare(`SELECT DISTINCT watched_day_local day FROM watches
    WHERE user_id=? AND qualifies_for_streak=1 AND deleted_at IS NULL
      AND watched_day_local IS NOT NULL`).all(uid).map((row) => row.day));
  const today = localDay(instant, user.timezone);
  const yesterday = previousCalendarDay(today);
  let cursor = days.has(today) ? today : days.has(yesterday) ? yesterday : null;
  if (!cursor) return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = previousCalendarDay(cursor);
  }
  return streak;
}
