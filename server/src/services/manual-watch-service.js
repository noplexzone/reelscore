import { db } from "../db.js";
import { notablePeopleInMovie } from "../people.js";
import { insertWatch } from "../repositories/watch-repository.js";
import { scoreWatchEvent } from "./scoring-service.js";
import {
  applyPreparedAchievementReconciliation,
  prepareAchievementReconciliation,
} from "./achievement-service.js";

function positiveId(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw Object.assign(new TypeError("userId must be a positive integer."), { status: 400 });
  }
  return value;
}

export async function logManualWatchAndReconcile(userId, movie, { watchedAt } = {}) {
  const uid = positiveId(userId);
  if (!movie || typeof movie !== "object" || !Number.isInteger(movie.id) || movie.id <= 0) {
    throw Object.assign(new TypeError("A valid movie is required."), { status: 400 });
  }
  const collectionIds = movie.belongs_to_collection?.id ? [movie.belongs_to_collection.id] : [];
  const personIds = notablePeopleInMovie(movie.credits).map((person) => person.id);
  // A manual event must not commit while a dynamic achievement basis is unknown.
  // Retrying the request is then safe: no watch, score, or partial trophy state exists.
  const prepared = await prepareAchievementReconciliation(uid, {
    collectionIds,
    personIds,
    requireExternalSuccess: true,
  });
  return db.transaction(() => {
    const watch = insertWatch({ userId: uid, movie, ...(watchedAt ? { watchedAt } : {}) });
    scoreWatchEvent(watch.id);
    const achievements = applyPreparedAchievementReconciliation(uid, prepared);
    const projection = db.prepare("SELECT id,points,is_rewatch,eligibility_reason FROM watches WHERE id=?").get(watch.id);
    return { watch: projection, achievements };
  }).immediate();
}
