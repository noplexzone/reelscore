import { db } from "../db.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });
function positiveId(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw httpError(400, `${name} must be a positive integer.`);
  return value;
}
function parseEvidence(raw) {
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export function duplicateFingerprint(tmdbId, day) {
  const id = positiveId(tmdbId, "tmdbId");
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw httpError(400, "watchedDayLocal must use YYYY-MM-DD.");
  const [year, month, date] = day.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) {
    throw httpError(400, "watchedDayLocal must be a valid calendar day.");
  }
  return `duplicate-v1:${id}:${day}`;
}
function closestManual(userId, candidate) {
  const rows = db.prepare(`SELECT * FROM watches WHERE user_id=? AND tmdb_id=? AND watched_day_local=?
    AND source='manual' AND deleted_at IS NULL ORDER BY id`).all(userId, candidate.tmdb_id, candidate.watched_day_local);
  const candidateTime = Date.parse(candidate.watched_at_utc);
  rows.sort((a, b) => Math.abs(Date.parse(a.watched_at_utc) - candidateTime) - Math.abs(Date.parse(b.watched_at_utc) - candidateTime) || a.id - b.id);
  return rows[0] || null;
}
function evidenceFor(candidate, canonical, personIds, prior = {}) {
  return {
    ...prior,
    tmdb_id: candidate.tmdb_id,
    watched_day_local: candidate.watched_day_local,
    canonical: canonical ? { id: canonical.id, source: canonical.source, watched_at_utc: canonical.watched_at_utc } : prior.canonical,
    candidate: { id: candidate.id, source: candidate.source, watched_at_utc: candidate.watched_at_utc },
    person_ids: personIds,
    absolute_delta_ms: canonical ? Math.abs(Date.parse(canonical.watched_at_utc) - Date.parse(candidate.watched_at_utc)) : prior.absolute_delta_ms,
  };
}
export function detectDuplicateCandidate(userId, candidateWatchId, { personIds = [] } = {}) {
  const uid = positiveId(userId, "userId");
  const candidateId = positiveId(candidateWatchId, "candidateWatchId");
  if (!Array.isArray(personIds)) throw new TypeError("personIds must be an array.");
  const normalizedPersonIds = [...new Set(personIds.map((id) => positiveId(id, "personId")))];
  const candidate = db.prepare(`SELECT * FROM watches WHERE id=? AND user_id=? AND deleted_at IS NULL
    AND provider_event_id IS NOT NULL AND source<>'manual'`).get(candidateId, uid);
  if (!candidate) return null;
  const fingerprint = duplicateFingerprint(candidate.tmdb_id, candidate.watched_day_local);
  if (db.prepare("SELECT 1 FROM duplicate_ignore_rules WHERE user_id=? AND fingerprint=?").get(uid, fingerprint)) return null;
  if (db.prepare("SELECT 1 FROM duplicate_cases WHERE user_id=? AND candidate_watch_id=?").get(uid, candidateId)) return null;
  const canonical = closestManual(uid, candidate);
  if (!canonical) return null;
  const info = db.prepare(`INSERT INTO duplicate_cases
    (user_id,fingerprint,canonical_watch_id,candidate_watch_id,evidence_json) VALUES (?,?,?,?,?)`)
    .run(uid, fingerprint, canonical.id, candidate.id, JSON.stringify(evidenceFor(candidate, canonical, normalizedPersonIds)));
  return Number(info.lastInsertRowid);
}
function cancelOrReassignPendingCase(userId, row, reason, now) {
  const candidate = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=?").get(row.candidate_watch_id, userId);
  if (!candidate) return null;
  const fingerprint = duplicateFingerprint(candidate.tmdb_id, candidate.watched_day_local);
  const evidence = parseEvidence(row.evidence_json);
  const personIds = Array.isArray(evidence.person_ids) ? evidence.person_ids.filter(Number.isInteger) : [];
  const canonical = candidate.deleted_at == null ? closestManual(userId, candidate) : null;
  if (canonical) {
    db.prepare(`UPDATE duplicate_cases SET fingerprint=?,canonical_watch_id=?,evidence_json=? WHERE id=? AND user_id=? AND status='pending'`)
      .run(fingerprint, canonical.id, JSON.stringify(evidenceFor(candidate, canonical, personIds, evidence)), row.id, userId);
    return candidate.tmdb_id;
  }
  const resolution = candidate.deleted_at == null ? "keep_both" : "merge";
  db.prepare(`UPDATE duplicate_cases SET fingerprint=?,status='resolved',resolution=?,resolved_at=?,
      cancelled_at=?,cancellation_reason=?,evidence_json=? WHERE id=? AND user_id=? AND status='pending'`)
    .run(fingerprint, resolution, now, now, reason, JSON.stringify(evidenceFor(candidate, null, personIds, evidence)), row.id, userId);
  return candidate.tmdb_id;
}
export function reconcilePendingDuplicatesAfterWatchDeletion(userId, watchId, now = new Date().toISOString()) {
  const uid = positiveId(userId, "userId");
  const wid = positiveId(watchId, "watchId");
  const rows = db.prepare(`SELECT * FROM duplicate_cases WHERE user_id=? AND status='pending'
    AND (canonical_watch_id=? OR candidate_watch_id=?) ORDER BY id`).all(uid, wid, wid);
  const affected = new Set();
  for (const row of rows) {
    const reason = row.candidate_watch_id === wid ? "candidate_watch_deleted" : "canonical_watch_deleted";
    const tmdbId = cancelOrReassignPendingCase(uid, row, reason, now);
    if (tmdbId) affected.add(tmdbId);
  }
  return [...affected];
}
export function rebaseDuplicateStateForTimezone(userId, now = new Date().toISOString()) {
  const uid = positiveId(userId, "userId");
  const rows = db.prepare(`SELECT d.*,w.tmdb_id,w.watched_day_local,w.deleted_at candidate_deleted_at
    FROM duplicate_cases d JOIN watches w ON w.id=d.candidate_watch_id WHERE d.user_id=? ORDER BY d.id`).all(uid);
  const affected = new Set();
  const ignoreMoves = [];
  for (const row of rows) {
    affected.add(row.tmdb_id);
    if (row.status === "pending") {
      cancelOrReassignPendingCase(uid, row, "timezone_no_matching_manual", now);
      continue;
    }
    const fingerprint = duplicateFingerprint(row.tmdb_id, row.watched_day_local);
    const evidence = parseEvidence(row.evidence_json);
    evidence.watched_day_local = row.watched_day_local;
    db.prepare("UPDATE duplicate_cases SET fingerprint=?,evidence_json=? WHERE id=? AND user_id=?")
      .run(fingerprint, JSON.stringify(evidence), row.id, uid);
    if (row.resolution === "ignore_future_matching" && row.cancelled_at == null && row.fingerprint !== fingerprint) {
      ignoreMoves.push([row.fingerprint, fingerprint]);
    }
  }
  for (const [, next] of ignoreMoves) db.prepare("INSERT OR IGNORE INTO duplicate_ignore_rules (user_id,fingerprint) VALUES (?,?)").run(uid, next);
  for (const [previous, next] of ignoreMoves) {
    if (previous !== next && !db.prepare(`SELECT 1 FROM duplicate_cases
      WHERE user_id=? AND resolution='ignore_future_matching' AND cancelled_at IS NULL AND fingerprint=?`).get(uid, previous)) {
      db.prepare("DELETE FROM duplicate_ignore_rules WHERE user_id=? AND fingerprint=?").run(uid, previous);
    }
  }
  return [...affected];
}
