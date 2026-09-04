import { db } from "../db.js";
import { collectionDetails, personDetails, personMovieCredits } from "../tmdb.js";
import { curatedPerson, filterFilmography, personBonus } from "../people.js";
import { awardScoreEvent, reverseScoreEvents } from "../repositories/score-ledger.js";
import { softDeleteWatch } from "../repositories/watch-repository.js";
import { reconcileMovieEligibility } from "./scoring-service.js";
import { reconcilePendingDuplicatesAfterWatchDeletion } from "./duplicate-state-service.js";
import { VOLUME_TIERS, GENRE_TIERS, DECADE_TIERS, STREAK_TIERS } from "../achievements.js";
import { CURATED_LISTS } from "../curated-lists.js";

export const ACHIEVEMENT_RULE_VERSION = "competitive-achievement-v1";
const QUALIFYING = "qualifies_for_achievement=1 AND deleted_at IS NULL";
const PREPARED_RECONCILIATION = Symbol("prepared-achievement-reconciliation");

function positiveId(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer number.`);
  }
  return value;
}

function maximumConsecutiveDays(days) {
  let maximum = 0;
  let run = 0;
  let previous = null;
  for (const day of [...new Set(days.filter(Boolean))].sort()) {
    const current = Date.parse(`${day}T00:00:00.000Z`);
    run = previous != null && current - previous === 86_400_000 ? run + 1 : 1;
    maximum = Math.max(maximum, run);
    previous = current;
  }
  return maximum;
}

function qualifyingFacts(userId) {
  const sourceRows = db.prepare(`SELECT id,tmdb_id,genres,release_date FROM watches
    WHERE user_id=? AND ${QUALIFYING} ORDER BY watched_at_utc,id`).all(userId);
  const byMovie = new Map();
  for (const row of sourceRows) if (!byMovie.has(row.tmdb_id)) byMovie.set(row.tmdb_id, row);
  const rows = [...byMovie.values()];
  const genres = new Map();
  const decades = new Set();
  for (const row of rows) {
    let values = [];
    try { values = JSON.parse(row.genres || "[]"); } catch {}
    for (const genre of new Set(Array.isArray(values) ? values : [])) {
      if (typeof genre === "string" && genre) genres.set(genre, (genres.get(genre) || 0) + 1);
    }
    const year = Number.parseInt(String(row.release_date || "").slice(0, 4), 10);
    if (Number.isInteger(year) && year >= 1880) decades.add(Math.floor(year / 10) * 10);
  }
  const days = db.prepare(`SELECT watched_day_local FROM watches
    WHERE user_id=? AND qualifies_for_streak=1 AND deleted_at IS NULL
      AND watched_day_local IS NOT NULL ORDER BY watched_day_local`).all(userId).map((row) => row.watched_day_local);
  return {
    count: rows.length,
    genres,
    decades: decades.size,
    streak: maximumConsecutiveDays(days),
    watchedIds: new Set(rows.map((row) => row.tmdb_id)),
  };
}

function staticRules(facts, existingKeys) {
  const rules = [];
  for (const tier of VOLUME_TIERS) rules.push({
    key: `volume:${tier.n}`, name: tier.name, description: tier.desc, points: tier.points,
    deserved: facts.count >= tier.n,
    metadata: { rule: "volume", threshold: tier.n, qualifying_watch_count: facts.count },
  });
  for (const [genre, count] of facts.genres) {
    for (const tier of GENRE_TIERS) rules.push(genreRule(genre, count, tier));
  }
  for (const key of existingKeys) {
    const match = /^genre:(.+):(\d+)$/.exec(key);
    if (!match || facts.genres.has(match[1])) continue;
    const tier = GENRE_TIERS.find((item) => item.n === Number(match[2]));
    if (tier) rules.push(genreRule(match[1], 0, tier));
  }
  for (const tier of DECADE_TIERS) rules.push({
    key: `decades:${tier.n}`, name: tier.name, description: tier.desc, points: tier.points,
    deserved: facts.decades >= tier.n,
    metadata: { rule: "decades", threshold: tier.n, qualifying_decade_count: facts.decades },
  });
  for (const tier of STREAK_TIERS) rules.push({
    key: `streak:${tier.n}`, name: tier.name, description: tier.desc, points: tier.points,
    deserved: facts.streak >= tier.n,
    metadata: { rule: "streak", threshold: tier.n, maximum_qualifying_local_day_run: facts.streak },
  });
  rules.push(...curatedListRules(facts));
  return rules;
}

function curatedListRules(facts) {
  return CURATED_LISTS.map((list) => {
    const requiredIds = list.films.map((film) => film.tmdb_id);
    const qualifyingIds = requiredIds.filter((id) => facts.watchedIds.has(id));
    return {
      key: list.award.key,
      name: list.award.name,
      description: list.award.description,
      points: list.award.points,
      deserved: qualifyingIds.length === requiredIds.length,
      metadata: {
        rule: "curated_list",
        list_slug: list.slug,
        list_version: list.version,
        required_tmdb_ids: requiredIds,
        qualifying_required_ids: qualifyingIds,
      },
    };
  });
}

function genreRule(genre, count, tier) {
  const level = tier.n === 10 ? "Fan" : tier.n === 25 ? "Devotee" : "Scholar";
  return {
    key: `genre:${genre}:${tier.n}`,
    name: `${genre} ${level}`,
    description: `Watch ${tier.n} ${genre} films`,
    points: tier.points,
    deserved: count >= tier.n,
    metadata: { rule: "genre", genre, threshold: tier.n, qualifying_watch_count: count },
  };
}

async function externalRules(userId, { collectionIds, personIds, requireExternalSuccess = false }) {
  const existing = db.prepare("SELECT key FROM achievements WHERE user_id=?").all(userId).map((row) => row.key);
  const requiredCollections = new Set(collectionIds);
  const requiredPeople = new Set(personIds);
  const collections = new Set(collectionIds);
  const people = new Set(personIds);
  for (const key of existing) {
    let match = /^series:(\d+)$/.exec(key);
    if (match) collections.add(Number(match[1]));
    match = /^person:(\d+)$/.exec(key);
    if (match) people.add(Number(match[1]));
  }

  const rules = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const collectionId of collections) {
    try {
      const collection = await collectionDetails(collectionId);
      const requiredIds = (collection.parts || [])
        .filter((part) => part.release_date && part.release_date <= today)
        .map((part) => Number(part.id)).filter(Number.isInteger);
      rules.push({
        key: `series:${collectionId}`,
        name: `Series Complete: ${String(collection.name || "Collection").replace(/ Collection$/i, "")}`,
        description: `Watched all ${requiredIds.length} released films`,
        points: 250 + 50 * requiredIds.length,
        minimumMet: requiredIds.length >= 2,
        requiredIds,
        metadata: { rule: "series", collection_id: collectionId, required_tmdb_ids: requiredIds },
      });
    } catch {
      if (requireExternalSuccess && requiredCollections.has(collectionId)) {
        const error = new Error("Achievement metadata is temporarily unavailable.");
        error.status = 502;
        throw error;
      }
      // Unknown external basis is intentionally omitted so an outage cannot revoke a trophy.
    }
  }

  for (const personId of people) {
    const curated = curatedPerson(personId);
    if (!curated) continue;
    try {
      const [credits, person] = await Promise.all([personMovieCredits(personId), personDetails(personId)]);
      const films = filterFilmography(curated.role, credits);
      const requiredIds = films.map((film) => Number(film.id));
      const verb = curated.role === "director" ? "directed by" : "starring";
      rules.push({
        key: `person:${personId}`,
        name: `Filmography Complete: ${person.name}`,
        description: `Watched all ${films.length} films ${verb} ${person.name}`,
        points: personBonus(films.length),
        minimumMet: films.length >= 3,
        requiredIds,
        metadata: { rule: "filmography", person_id: personId, role: curated.role, required_tmdb_ids: requiredIds },
      });
    } catch {
      if (requireExternalSuccess && requiredPeople.has(personId)) {
        const error = new Error("Achievement metadata is temporarily unavailable.");
        error.status = 502;
        throw error;
      }
      // Unknown external basis is intentionally omitted so an outage cannot revoke a trophy.
    }
  }
  return rules;
}

function awardGeneration(userId, row, rule, now) {
  const generation = db.prepare(`SELECT COUNT(*) count FROM score_events
    WHERE user_id=? AND achievement_id=? AND reverses_event_id IS NULL`).get(userId, row.id).count + 1;
  const event = awardScoreEvent({
    eventKey: `achievement/${row.id}/${ACHIEVEMENT_RULE_VERSION}/${generation}`,
    userId,
    achievementId: row.id,
    category: "achievement",
    points: row.points,
    ruleVersion: ACHIEVEMENT_RULE_VERSION,
    metadata: {
      key: row.key,
      name: row.name,
      stored_points: row.points,
      generation,
      ...rule.metadata,
    },
    createdAt: now,
  });
  db.prepare(`UPDATE achievements SET score_event_id=?,revoked_at=NULL,revocation_reason=NULL
    WHERE id=? AND user_id=?`).run(event.id, row.id, userId);
  return event;
}

function applyRule(userId, rule, now) {
  let row = db.prepare("SELECT * FROM achievements WHERE user_id=? AND key=?").get(userId, rule.key);
  if (!rule.deserved) {
    if (row && row.revoked_at == null) {
      const activeAward = db.prepare(`SELECT id FROM score_events
        WHERE user_id=? AND achievement_id=? AND reverses_event_id IS NULL AND reversed_at IS NULL
        ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,id DESC LIMIT 1`)
        .get(userId, row.id, row.score_event_id ?? -1);
      if (activeAward) {
        reverseScoreEvents({ userId, eventIds: [activeAward.id], reason: "achievement_basis_lost", reversedAt: now });
      }
      db.prepare(`UPDATE achievements SET revoked_at=?,revocation_reason='achievement_basis_lost'
        WHERE id=? AND user_id=?`).run(now, row.id, userId);
    }
    return null;
  }

  let activated = false;
  if (!row) {
    const result = db.prepare(`INSERT INTO achievements (user_id,key,name,description,points)
      VALUES (?,?,?,?,?)`).run(userId, rule.key, rule.name, rule.description, rule.points);
    row = db.prepare("SELECT * FROM achievements WHERE id=?").get(Number(result.lastInsertRowid));
    activated = true;
  } else if (row.revoked_at != null) {
    db.prepare(`UPDATE achievements SET name=?,description=?,points=? WHERE id=? AND user_id=?`)
      .run(rule.name, rule.description, rule.points, row.id, userId);
    row = db.prepare("SELECT * FROM achievements WHERE id=?").get(row.id);
    activated = true;
  }

  const activeEvent = row.score_event_id == null ? null : db.prepare(`SELECT id FROM score_events
    WHERE id=? AND user_id=? AND achievement_id=? AND reverses_event_id IS NULL AND reversed_at IS NULL`)
    .get(row.score_event_id, userId, row.id);
  if (!activeEvent) awardGeneration(userId, row, rule, now);
  if (!activated && activeEvent) return null;
  const current = db.prepare("SELECT key,name,description,points FROM achievements WHERE id=?").get(row.id);
  return current;
}

export function prepareStaticAchievementReconciliation(userId) {
  const uid = positiveId(userId, "userId");
  return Object.freeze({ [PREPARED_RECONCILIATION]: true, userId: uid, fetched: Object.freeze([]) });
}

export async function prepareAchievementReconciliation(userId, { collectionIds = [], personIds = [], requireExternalSuccess = false } = {}) {
  const uid = positiveId(userId, "userId");
  if (!Array.isArray(collectionIds) || !Array.isArray(personIds)) throw new TypeError("collectionIds and personIds must be arrays.");
  if (typeof requireExternalSuccess !== "boolean") throw new TypeError("requireExternalSuccess must be a boolean.");
  const normalizedCollections = [...new Set(collectionIds.map((id) => positiveId(id, "collectionId")))];
  const normalizedPeople = [...new Set(personIds.map((id) => positiveId(id, "personId")))];
  const fetched = await externalRules(uid, { collectionIds: normalizedCollections, personIds: normalizedPeople, requireExternalSuccess });
  return Object.freeze({ [PREPARED_RECONCILIATION]: true, userId: uid, fetched });
}

export function applyPreparedAchievementReconciliation(userId, prepared) {
  const uid = positiveId(userId, "userId");
  if (!prepared || prepared[PREPARED_RECONCILIATION] !== true || prepared.userId !== uid || !Array.isArray(prepared.fetched)) {
    throw new TypeError("A matching prepared achievement reconciliation is required.");
  }
  return db.transaction(() => {
    const facts = qualifyingFacts(uid);
    const existingKeys = db.prepare("SELECT key FROM achievements WHERE user_id=?").all(uid).map((row) => row.key);
    const external = prepared.fetched.map((rule) => ({
      ...rule,
      deserved: rule.minimumMet && rule.requiredIds.every((id) => facts.watchedIds.has(id)),
      metadata: { ...rule.metadata, qualifying_required_ids: rule.requiredIds.filter((id) => facts.watchedIds.has(id)) },
    }));
    const now = new Date().toISOString();
    return [...staticRules(facts, existingKeys), ...external]
      .map((rule) => applyRule(uid, rule, now)).filter(Boolean);
  })();
}

export async function reconcileAchievements(userId, options = {}) {
  const prepared = await prepareAchievementReconciliation(userId, options);
  return applyPreparedAchievementReconciliation(userId, prepared);
}

export function reconcileCuratedListAchievementsForAllUsers() {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const activated = [];
    for (const { id } of db.prepare("SELECT id FROM users ORDER BY id").all()) {
      const facts = qualifyingFacts(id);
      for (const rule of curatedListRules(facts)) {
        const result = applyRule(id, rule, now);
        if (result) activated.push({ user_id: id, ...result });
      }
    }
    return activated;
  }).immediate();
}

export async function deleteWatchAndReconcileAchievements(userId, watchId) {
  const uid = positiveId(userId, "userId");
  const wid = positiveId(watchId, "watchId");
  const before = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=?").get(wid, uid);
  if (!before || (before.deleted_at != null && before.deleted_reason !== "user_deleted")) return null;
  const prepared = await prepareAchievementReconciliation(uid, {
    collectionIds: before.collection_id ? [before.collection_id] : [],
  });
  return db.transaction(() => {
    const current = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=?").get(wid, uid);
    if (!current || (current.deleted_at != null && current.deleted_reason !== "user_deleted")) return null;
    const deleted = current.deleted_at == null ? softDeleteWatch(uid, wid) : current;
    if (!deleted) return null;
    const duplicateMovies = reconcilePendingDuplicatesAfterWatchDeletion(uid, wid);
    reconcileMovieEligibility(uid, [...new Set([deleted.tmdb_id, ...duplicateMovies])]);
    applyPreparedAchievementReconciliation(uid, prepared);
    return deleted;
  }).immediate();
}

export function achievementProgress(userId) {
  const facts = qualifyingFacts(positiveId(userId, "userId"));
  const curatedLists = CURATED_LISTS.map((list) => {
    const count = list.films.reduce((total, film) => total + Number(facts.watchedIds.has(film.tmdb_id)), 0);
    return { slug: list.slug, version: list.version, count, total: list.films.length, complete: count === list.films.length };
  });
  return { volume: facts.count, streak: facts.streak, decades: facts.decades, curated_lists: curatedLists };
}
