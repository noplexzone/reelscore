// Point economy (v1):
//   base = 100 * (rating/10)^2 * clamp(runtime/120, 0.5, 2)
//   Rewatch pays 25% of base; rewatching the same film within 30 days pays 0.
// Squaring the rating rewards exploration of acclaimed films without making
// low-rated films worthless. Runtime factor keeps a 3h epic worth more than
// a 75-minute quickie, clamped so neither dominates.

const REWATCH_RATE = 0.25;
const REWATCH_COOLDOWN_DAYS = 30;

export function basePoints({ voteAverage, runtime }) {
  const rating = Math.min(Math.max(voteAverage || 5, 0), 10);
  const rt = runtime && runtime > 0 ? runtime : 100;
  const runtimeFactor = Math.min(Math.max(rt / 120, 0.5), 2);
  return Math.round(100 * Math.pow(rating / 10, 2) * runtimeFactor);
}

export function watchPoints({ voteAverage, runtime, priorWatches }) {
  const base = basePoints({ voteAverage, runtime });
  if (!priorWatches || priorWatches.length === 0) {
    return { points: base, isRewatch: false, reason: "first_watch" };
  }
  const last = priorWatches[0]; // most recent, ISO datetime string
  const daysSince = (Date.now() - new Date(last + "Z").getTime()) / 86400000;
  if (daysSince < REWATCH_COOLDOWN_DAYS) {
    return { points: 0, isRewatch: true, reason: "rewatch_cooldown" };
  }
  return {
    points: Math.round(base * REWATCH_RATE),
    isRewatch: true,
    reason: "rewatch",
  };
}
