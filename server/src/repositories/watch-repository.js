import { db } from "../db.js";
import { localDay, normalizeUtcInstant } from "../time.js";

function legacyTimestamp(instant) {
  return instant.replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function requiredTrimmed(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty trimmed string of at most ${maxLength} characters.`);
  }
  return value;
}

function sourceDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("sourceRecordedDate must be a valid YYYY-MM-DD date.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError("sourceRecordedDate must be a valid YYYY-MM-DD date.");
  }
  return value;
}

function importProvenance({ competitionEligibility, source, sourceRecordedDate, sourceDateKind, importSource,
  importEventKey, providerService, providerConnectionId, providerEventId }) {
  if (!new Set(["eligible", "unverified_import"]).has(competitionEligibility)) {
    throw new TypeError("competitionEligibility must be eligible or unverified_import.");
  }
  if (competitionEligibility === "eligible") {
    if (source === "letterboxd") {
      throw new TypeError("Letterboxd watches must be unverified imports.");
    }
    if ([sourceRecordedDate, sourceDateKind, importSource, importEventKey].some((value) => value != null)) {
      throw new TypeError("Import provenance requires an unverified import watch.");
    }
    return { sourceRecordedDate: null, sourceDateKind: null, importSource: null, importEventKey: null };
  }
  if (source !== "letterboxd" || [providerService, providerConnectionId, providerEventId].some((value) => value != null)) {
    throw new TypeError("An unverified import must use Letterboxd provenance and no provider identity.");
  }
  if (!["watched_day", "marked_watched_day"].includes(sourceDateKind)) {
    throw new TypeError("sourceDateKind must be watched_day or marked_watched_day for an unverified import.");
  }
  const normalizedImportSource = requiredTrimmed(importSource, "importSource", 64);
  if (normalizedImportSource !== "letterboxd") {
    throw new TypeError("importSource must be letterboxd for an unverified import.");
  }
  return {
    sourceRecordedDate: sourceDate(sourceRecordedDate),
    sourceDateKind,
    importSource: normalizedImportSource,
    importEventKey: requiredTrimmed(importEventKey, "importEventKey", 1000),
  };
}

export function insertWatch({
  userId,
  movie,
  source = "manual",
  watchedAt = new Date().toISOString(),
  providerService = null,
  providerConnectionId = null,
  providerEventId = null,
  competitionEligibility = "eligible",
  sourceRecordedDate = null,
  sourceDateKind = null,
  importSource = null,
  importEventKey = null,
}) {
  const provenance = importProvenance({ competitionEligibility, source, sourceRecordedDate, sourceDateKind,
    importSource, importEventKey, providerService, providerConnectionId, providerEventId });
  const instant = normalizeUtcInstant(watchedAt);
  const timezone = db.prepare("SELECT timezone FROM users WHERE id=?").get(userId)?.timezone || "UTC";
  const values = [
    userId, movie.id, movie.title, movie.poster_path ?? null, movie.vote_average ?? null, movie.runtime ?? null,
    movie.release_date ?? null, JSON.stringify((movie.genres || []).map((genre) => typeof genre === "string" ? genre : genre.name)),
    movie.belongs_to_collection?.id ?? null, movie.belongs_to_collection?.name ?? null,
    source, legacyTimestamp(instant), instant, localDay(instant, timezone), timezone,
    providerService, providerConnectionId, providerEventId,
  ];
  const hasImportSchema = db.prepare("SELECT 1 FROM pragma_table_info('watches') WHERE name='competition_eligibility'").get();
  if (!hasImportSchema) {
    if (competitionEligibility !== "eligible") throw new Error("Unverified imports require database schema 15.");
    const info = db.prepare(`INSERT INTO watches
      (user_id,tmdb_id,title,poster_path,vote_average,runtime,release_date,genres,collection_id,collection_name,
       points,is_rewatch,source,watched_at,watched_at_utc,watched_day_local,timezone_used,
       provider_service,provider_connection_id,provider_event_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,provider_service,provider_connection_id,provider_event_id)
        WHERE provider_event_id IS NOT NULL DO NOTHING`).run(...values);
    return info.changes ? db.prepare("SELECT * FROM watches WHERE id=?").get(info.lastInsertRowid) : null;
  }

  const info = db.prepare(`INSERT INTO watches
    (user_id,tmdb_id,title,poster_path,vote_average,runtime,release_date,genres,collection_id,collection_name,
     points,is_rewatch,source,watched_at,watched_at_utc,watched_day_local,timezone_used,
     provider_service,provider_connection_id,provider_event_id,competition_eligibility,
     source_recorded_date,source_date_kind,import_source,import_event_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,provider_service,provider_connection_id,provider_event_id)
      WHERE provider_event_id IS NOT NULL DO NOTHING
    ON CONFLICT(user_id,import_source,import_event_key)
      WHERE import_source IS NOT NULL AND import_event_key IS NOT NULL DO NOTHING`).run(
    ...values, competitionEligibility, provenance.sourceRecordedDate, provenance.sourceDateKind,
    provenance.importSource, provenance.importEventKey,
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
