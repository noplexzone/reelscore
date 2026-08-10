import { db } from "../db.js";
import { reconcileMovieEligibility } from "./scoring-service.js";
import { applyPreparedAchievementReconciliation, prepareAchievementReconciliation } from "./achievement-service.js";
export { detectDuplicateCandidate, duplicateFingerprint } from "./duplicate-state-service.js";

export const DUPLICATE_ACTIONS = Object.freeze(["merge", "keep_both", "keep_separate", "ignore_future_matching"]);
const httpError = (status, message) => Object.assign(new Error(message), { status });
function positiveId(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw httpError(400, `${name} must be a positive integer.`);
  return value;
}
function safeWatch(row, prefix) {
  return { id: row[`${prefix}_id`], tmdb_id: row[`${prefix}_tmdb_id`], title: row[`${prefix}_title`], poster_path: row[`${prefix}_poster_path`], source: row[`${prefix}_source`], watched_at: row[`${prefix}_watched_at`], watched_at_utc: row[`${prefix}_watched_at_utc`], watched_day_local: row[`${prefix}_watched_day_local`], deleted: row[`${prefix}_deleted_at`] != null };
}
function parseEvidence(raw) { try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function caseDto(row) { return { id: row.id, status: row.status, resolution: row.resolution, cancelled_at: row.cancelled_at, cancellation_reason: row.cancellation_reason, created_at: row.created_at, resolved_at: row.resolved_at, evidence: parseEvidence(row.evidence_json), canonical_watch: safeWatch(row, "canonical"), candidate_watch: safeWatch(row, "candidate") }; }
const CASE_SELECT = `SELECT d.*,
  c.id canonical_id,c.tmdb_id canonical_tmdb_id,c.title canonical_title,c.poster_path canonical_poster_path,c.source canonical_source,c.watched_at canonical_watched_at,c.watched_at_utc canonical_watched_at_utc,c.watched_day_local canonical_watched_day_local,c.deleted_at canonical_deleted_at,
  p.id candidate_id,p.tmdb_id candidate_tmdb_id,p.title candidate_title,p.poster_path candidate_poster_path,p.source candidate_source,p.watched_at candidate_watched_at,p.watched_at_utc candidate_watched_at_utc,p.watched_day_local candidate_watched_day_local,p.deleted_at candidate_deleted_at
  FROM duplicate_cases d JOIN watches c ON c.id=d.canonical_watch_id JOIN watches p ON p.id=d.candidate_watch_id`;
export function getDuplicateCases(userId, status = "pending") {
  const uid = positiveId(userId, "userId");
  if (!["pending", "resolved"].includes(status)) throw httpError(400, "status must be pending or resolved.");
  return db.prepare(`${CASE_SELECT} WHERE d.user_id=? AND d.status=? ORDER BY d.created_at DESC,d.id DESC`).all(uid, status).map(caseDto);
}
function getCase(userId, caseId) { const row = db.prepare(`${CASE_SELECT} WHERE d.user_id=? AND d.id=?`).get(userId, caseId); return row ? caseDto(row) : null; }

export async function resolveDuplicateCase(userId, caseId, action) {
  const uid = positiveId(userId, "userId"); const did = positiveId(caseId, "duplicateId");
  if (typeof action !== "string" || !DUPLICATE_ACTIONS.includes(action)) throw httpError(400, "action must be merge, keep_both, keep_separate, or ignore_future_matching.");
  const before = db.prepare("SELECT d.*,w.collection_id FROM duplicate_cases d JOIN watches w ON w.id=d.candidate_watch_id WHERE d.id=? AND d.user_id=?").get(did, uid);
  if (!before) throw httpError(404, "Duplicate case not found.");
  if (before.status === "resolved") { if (before.resolution !== action || before.cancelled_at != null) throw httpError(409, "Duplicate case was already resolved differently."); return getCase(uid, did); }
  const evidence = parseEvidence(before.evidence_json);
  const personIds = Array.isArray(evidence.person_ids) ? evidence.person_ids : [];
  const prepared = await prepareAchievementReconciliation(uid, {
    collectionIds: before.collection_id ? [before.collection_id] : [], personIds, requireExternalSuccess: true,
  });
  return db.transaction(() => {
    const current = db.prepare("SELECT d.*,w.tmdb_id,w.watched_day_local FROM duplicate_cases d JOIN watches w ON w.id=d.candidate_watch_id WHERE d.id=? AND d.user_id=?").get(did, uid);
    if (!current) throw httpError(404, "Duplicate case not found.");
    if (current.status === "resolved") { if (current.resolution !== action || current.cancelled_at != null) throw httpError(409, "Duplicate case was already resolved differently."); return getCase(uid, did); }
    const candidate = db.prepare("SELECT * FROM watches WHERE id=? AND user_id=?").get(current.candidate_watch_id, uid);
    if (!candidate) throw httpError(404, "Duplicate case not found.");
    const resolvedAt = new Date().toISOString();
    const fingerprint = `duplicate-v1:${candidate.tmdb_id}:${candidate.watched_day_local}`;
    if (action === "merge") db.prepare(`UPDATE watches SET deleted_at=?,deleted_reason='duplicate_merged',logical_canonical_watch_id=? WHERE id=? AND user_id=?`).run(resolvedAt, current.canonical_watch_id, current.candidate_watch_id, uid);
    else if (action === "ignore_future_matching") db.prepare("INSERT OR IGNORE INTO duplicate_ignore_rules (user_id,fingerprint) VALUES (?,?)").run(uid, fingerprint);
    db.prepare(`UPDATE duplicate_cases SET fingerprint=?,status='resolved',resolution=?,resolved_at=?,cancelled_at=NULL,cancellation_reason=NULL WHERE id=? AND user_id=? AND status='pending'`).run(fingerprint, action, resolvedAt, did, uid);
    reconcileMovieEligibility(uid, [candidate.tmdb_id]);
    applyPreparedAchievementReconciliation(uid, prepared);
    return getCase(uid, did);
  }).immediate();
}
