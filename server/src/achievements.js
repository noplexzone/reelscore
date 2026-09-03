// Achievement catalog and compatibility facade. Eligibility, revocation, and
// ledger writes live in services/achievement-service.js.
import { achievementProgress, reconcileAchievements } from "./services/achievement-service.js";
export { CURATED_LISTS, curatedList } from "./curated-lists.js";

export const VOLUME_TIERS = [
  { n: 1, points: 25, name: "Opening Night", desc: "Log your first film" },
  { n: 10, points: 50, name: "Regular", desc: "Log 10 films" },
  { n: 50, points: 150, name: "Cinephile", desc: "Log 50 films" },
  { n: 100, points: 300, name: "Projectionist", desc: "Log 100 films" },
  { n: 250, points: 750, name: "The Archive", desc: "Log 250 films" },
];

export const GENRE_TIERS = [
  { n: 10, points: 75 },
  { n: 25, points: 200 },
  { n: 50, points: 400 },
];

export const DECADE_TIERS = [
  { n: 5, points: 150, name: "Time Traveler", desc: "Watch films from 5 different decades" },
  { n: 8, points: 350, name: "Century Pass", desc: "Watch films from 8 different decades" },
  { n: 11, points: 700, name: "Full Reel of History", desc: "Watch films from 11 different decades" },
];

export const STREAK_TIERS = [
  { n: 3, points: 50, name: "Triple Feature", desc: "Watch films 3 days in a row" },
  { n: 7, points: 150, name: "Weeklong Premiere", desc: "Watch films 7 days in a row" },
  { n: 30, points: 600, name: "Resident Critic", desc: "Watch films 30 days in a row" },
];

export async function evaluate(userId, watch = {}) {
  return reconcileAchievements(userId, {
    collectionIds: watch.collection_id ? [watch.collection_id] : [],
    personIds: Array.isArray(watch.person_ids) ? watch.person_ids : [],
  });
}

export async function checkPersonCompletion(userId, personId) {
  const unlocked = await evaluate(userId, { person_ids: [personId] });
  return unlocked.find((achievement) => achievement.key === `person:${Number(personId)}`) || null;
}

export function progress(userId) {
  return achievementProgress(userId);
}
