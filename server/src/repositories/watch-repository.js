import { db } from "../db.js";
import { localDay, normalizeUtcInstant } from "../time.js";

function legacyTimestamp(instant) {
  return instant.replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function insertWatch({
  userId,
  movie,
  source = "manual",
  watchedAt = new Date().toISOString(),
  providerService = null,
  providerConnectionId = null,
  providerEventId = null,
}) {
  const instant = normalizeUtcInstant(watchedAt);
  const timezone = db.prepare("SELECT timezone FROM users WHERE id=?").get(userId)?.timezone || "UTC";
  const info = db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,poster_path,vote_average,runtime,release_date,genres,collection_id,collection_name,
     points,is_rewatch,source,watched_at,watched_at_utc,watched_day_local,timezone_used,
     provider_service,provider_connection_id,provider_event_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,provider_service,provider_connection_id,provider_event_id)
      WHERE provider_event_id IS NOT NULL DO NOTHING`).run(
    userId, movie.id, movie.title, movie.poster_path ?? null, movie.vote_average ?? null, movie.runtime ?? null,
    movie.release_date ?? null, JSON.stringify((movie.genres || []).map((genre) => typeof genre === "string" ? genre : genre.name)),
    movie.belongs_to_collection?.id ?? null, movie.belongs_to_collection?.name ?? null,
    source, legacyTimestamp(instant), instant, localDay(instant, timezone), timezone,
    providerService, providerConnectionId, providerEventId,
  );
  return info.changes ? db.prepare("SELECT * FROM watches WHERE id=?").get(info.lastInsertRowid) : null;
}

export function softDeleteWatch(userId, watchId, reason = "user_deleted", deletedAt = new Date().toISOString()) {
  const watch = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=? AND deleted_at IS NULL").get(watchId, userId);
  if (!watch) return null;
  const result = db.prepare("UPDATE watches SET deleted_at=?,deleted_reason=? WHERE id=? AND user_id=? AND deleted_at IS NULL")
    .run(deletedAt, reason, watchId, userId);
  return result.changes === 1 ? watch : null;
}
