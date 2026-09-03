import { db } from "../db.js";
import { CURATED_LISTS, curatedList } from "../curated-lists.js";

function positiveUserId(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError("userId must be a positive integer number.");
  }
  return value;
}

function qualifyingWatchIds(userId) {
  return new Set(
    db.prepare(`SELECT DISTINCT tmdb_id FROM watches
      WHERE user_id=? AND qualifies_for_achievement=1 AND deleted_at IS NULL`)
      .all(positiveUserId(userId))
      .map((row) => row.tmdb_id),
  );
}

function awardDto(award) {
  return {
    key: award.key,
    points: award.points,
    name: award.name,
    description: award.description,
  };
}

function summaryDto(list, watchedIds) {
  const watched = list.films.reduce(
    (count, film) => count + Number(watchedIds.has(film.tmdb_id)),
    0,
  );
  return {
    slug: list.slug,
    version: list.version,
    name: list.name,
    award: awardDto(list.award),
    watched,
    total: list.films.length,
    complete: watched === list.films.length,
  };
}

export function curatedListSummaries(userId) {
  const watchedIds = qualifyingWatchIds(userId);
  return CURATED_LISTS.map((list) => summaryDto(list, watchedIds));
}

export function curatedListDetail(userId, slug) {
  const list = curatedList(slug);
  if (!list) return null;
  const watchedIds = qualifyingWatchIds(userId);
  return {
    ...summaryDto(list, watchedIds),
    films: list.films.map((film) => ({
      order: film.order,
      tmdb_id: film.tmdb_id,
      title: film.title,
      year: film.year,
      poster_path: film.poster_path,
      watched: watchedIds.has(film.tmdb_id),
    })),
  };
}
