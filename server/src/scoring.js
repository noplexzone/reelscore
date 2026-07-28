// Point economy (v1):
//   base = 100 * (rating/10)^2 * clamp(runtime/120, 0.5, 2)
//   Rewatch pays 25% of base; rewatching the same film within 30 days pays 0.
// Squaring the rating rewards exploration of acclaimed films without making
// low-rated films worthless. Runtime factor keeps a 3h epic worth more than
// a 75-minute quickie, clamped so neither dominates.

const REWATCH_RATE = 0.25;
const REWATCH_COOLDOWN_DAYS = 30;

export function basePoints({ voteAverage, runtime }) {
  const rating = Math.min(Math.max(voteAverage ?? 5, 0), 10);
  const rt = runtime && runtime > 0 ? runtime : 100;
  const runtimeFactor = Math.min(Math.max(rt / 120, 0.5), 2);
  return Math.round(100 * Math.pow(rating / 10, 2) * runtimeFactor);
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || "");
  return new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`).getTime();
}

export function watchPoints({ voteAverage, runtime, priorWatches, watchedAt = new Date() }) {
  const base = basePoints({ voteAverage, runtime });
  const current = timestamp(watchedAt);
  const earlier = (priorWatches || [])
    .map((value) => ({ value, time: timestamp(value) }))
    // The caller supplies prior events in deterministic order. Equal-time
    // entries already visited are therefore prior watches by row/event tie-break.
    .filter(({ time }) => Number.isFinite(time) && time <= current)
    .sort((a, b) => b.time - a.time);
  if (earlier.length === 0) {
    return { points: base, isRewatch: false, reason: "first_watch" };
  }
  const daysSince = (current - earlier[0].time) / 86400000;
  if (daysSince < REWATCH_COOLDOWN_DAYS) {
    return { points: 0, isRewatch: true, reason: "rewatch_cooldown" };
  }
  return {
    points: Math.round(base * REWATCH_RATE),
    isRewatch: true,
    reason: "rewatch",
  };
}
