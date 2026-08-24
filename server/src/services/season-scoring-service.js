import { db } from "../db.js";
import { awardScoreEvent, reverseSeasonProjectionChainEvents } from "../repositories/score-ledger.js";

const WATCH_CATEGORIES = new Set(["watch_first", "watch_rewatch", "watch_cooldown"]);
const USER_OPTION_KEYS = new Set(["tmdbIds", "seasonIds", "enforcePostEndGrace"]);
const BATCH_OPTION_KEYS = new Set(["afterUserId", "limit", "enforcePostEndGrace"]);
const MAX_FILTER_IDS = 100;
const DEFAULT_BATCH_LIMIT = 50;

function positiveId(value, name, { optional = false } = {}) {
  if (value === undefined && optional) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer number.`);
  }
  return value;
}
function exactObject(value, name, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unsupported field.`);
  return value;
}
function idArray(value, name) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  if (value.length > MAX_FILTER_IDS) throw new RangeError(`${name} must contain at most ${MAX_FILTER_IDS} IDs.`);
  const ids = value.map((id) => positiveId(id, `${name} item`));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${name} must not contain duplicate IDs.`);
  return ids;
}
function placeholders(values) { return values.map(() => "?").join(","); }
function parseMetadata(value) { try { return JSON.parse(value); } catch { return {}; } }
function addMillis(instant, ms) { return new Date(new Date(instant).getTime() + ms).toISOString(); }
const POST_END_GRACE_MS = 72 * 60 * 60 * 1000;

function providerEvidence(watch) {
  const direct = watch.source !== "manual" && watch.provider_service && watch.provider_connection_id && watch.provider_event_id;
  if (direct && watch.source === watch.provider_service) return { kind: "direct_provider", reference: `watch/${watch.watch_id}` };
  const placeholder = db.prepare(`SELECT p.id provider_watch_id FROM watches p
    WHERE p.user_id=? AND p.logical_canonical_watch_id=? AND p.deleted_at IS NOT NULL
      AND p.deleted_reason='placeholder_reconciled' AND p.source<>'manual'
      AND p.provider_service IS NOT NULL AND p.provider_connection_id IS NOT NULL AND p.provider_event_id IS NOT NULL
    ORDER BY p.id LIMIT 1`).get(watch.user_id, watch.watch_id);
  if (placeholder) return { kind: "reconciled_provider", reference: `watch/${placeholder.provider_watch_id}` };
  if (watch.source !== "manual") return null;
  const merged = db.prepare(`SELECT d.id,p.id provider_watch_id FROM duplicate_cases d
    JOIN watches p ON p.id=d.candidate_watch_id
    WHERE d.user_id=? AND d.canonical_watch_id=? AND d.status='resolved' AND d.resolution='merge'
      AND d.cancelled_at IS NULL AND p.user_id=? AND p.deleted_at IS NOT NULL AND p.deleted_reason='duplicate_merged'
      AND p.logical_canonical_watch_id=? AND p.source<>'manual'
      AND p.provider_service IS NOT NULL AND p.provider_connection_id IS NOT NULL AND p.provider_event_id IS NOT NULL
    ORDER BY d.id LIMIT 1`).get(watch.user_id, watch.watch_id, watch.user_id, watch.watch_id);
  return merged ? { kind: "merged_provider", reference: `duplicate/${merged.id}/watch/${merged.provider_watch_id}` } : null;
}

function sourceRows(userId, tmdbIds) {
  const filter = tmdbIds === null ? "" : ` AND w.tmdb_id IN (${placeholders(tmdbIds)})`;
  return db.prepare(`SELECT e.*,w.tmdb_id,w.source,w.provider_service,w.provider_connection_id,w.provider_event_id,
      w.qualifies_for_season,w.deleted_at
    FROM score_events e JOIN watches w ON w.id=e.watch_id AND w.user_id=e.user_id
    WHERE e.user_id=? AND e.season_id IS NULL AND e.reverses_event_id IS NULL
      AND e.reversed_at IS NULL AND e.category IN ('watch_first','watch_rewatch','watch_cooldown')
      AND NOT EXISTS (SELECT 1 FROM score_events r WHERE r.reverses_event_id=e.id)
      AND w.deleted_at IS NULL${filter}
    ORDER BY e.effective_at,e.id`).all(userId, ...(tmdbIds ?? []));
}
function candidateSeasons(userId, seasonIds) {
  const filter = seasonIds === null ? "" : ` AND s.id IN (${placeholders(seasonIds)})`;
  return db.prepare(`SELECT s.*,sm.id season_member_id,sm.eligible_from,sm.eligible_until
    FROM seasons s JOIN leagues l ON l.id=s.league_id
    JOIN season_members sm ON sm.season_id=s.id AND sm.user_id=?
    WHERE s.participants_locked_at IS NOT NULL AND l.archived_at IS NULL${filter} ORDER BY s.id`).all(userId, ...(seasonIds ?? []));
}
function requestedFrozenSeasonIds(userId, seasonIds) {
  const filter = seasonIds === null ? "" : ` AND s.id IN (${placeholders(seasonIds)})`;
  return db.prepare(`SELECT s.id FROM seasons s JOIN leagues l ON l.id=s.league_id
    WHERE (s.cancelled_at IS NOT NULL OR s.finalized_at IS NOT NULL OR l.archived_at IS NOT NULL)
      AND (EXISTS (SELECT 1 FROM season_members sm WHERE sm.season_id=s.id AND sm.user_id=?)
        OR EXISTS (SELECT 1 FROM score_events e WHERE e.season_id=s.id AND e.user_id=?))${filter}
    ORDER BY s.id`).all(userId, userId, ...(seasonIds ?? [])).map((row) => row.id);
}
function within(value, start, end) { return value >= start && value < end; }
function instantMs(value, name) {
  const text = String(value);
  const canonical = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(canonical);
  if (!Number.isFinite(ms)) throw new Error(`${name} must be a valid timestamp.`);
  return ms;
}
function hasPreEndResolvedDuplicate(source, season) {
  return !!db.prepare(`SELECT 1 FROM duplicate_cases d
    WHERE d.user_id=? AND d.status='resolved' AND d.cancelled_at IS NULL
      AND d.created_at IS NOT NULL AND d.resolved_at IS NOT NULL
      AND julianday(d.created_at)<julianday(?) AND julianday(d.resolved_at)<julianday(?)
      AND (d.canonical_watch_id=? OR d.candidate_watch_id=?) LIMIT 1`)
    .get(source.user_id, season.ends_at, season.ends_at, source.watch_id, source.watch_id);
}
function allowedByPostEndGrace(source, season) {
  const receivedMs = instantMs(source.created_at, "source created_at");
  const endMs = instantMs(season.ends_at, "season ends_at");
  if (receivedMs < endMs) return true;
  if (!within(source.effective_at, season.starts_at, season.ends_at)) return false;
  if (source.source === "manual") return hasPreEndResolvedDuplicate(source, season);
  return source.source === source.provider_service && source.provider_connection_id != null && source.provider_event_id != null
    && receivedMs < endMs + POST_END_GRACE_MS;
}
function desiredFor(userId, tmdbIds, seasonIds, enforcePostEndGrace) {
  const sources = sourceRows(userId, tmdbIds);
  const seasons = candidateSeasons(userId, seasonIds).filter((row) => row.cancelled_at == null && row.finalized_at == null);
  const desired = new Map();
  for (const season of seasons) {
    for (const source of sources) {
      if (!WATCH_CATEGORIES.has(source.category) || source.qualifies_for_season !== 1) continue;
      if (!within(source.effective_at, season.starts_at, season.ends_at)) continue;
      if (enforcePostEndGrace && !allowedByPostEndGrace(source, season)) continue;
      if (!within(source.effective_at, season.eligible_from, season.eligible_until ?? season.ends_at)) continue;
      let evidence = { kind: "season_eligible" };
      if (season.mode === "verified") {
        evidence = providerEvidence(source);
        if (!evidence) continue;
      }
      const key = `${season.id}:${source.id}`;
      desired.set(key, {
        season, source, evidence,
        eventKey: `season/${season.id}/watch-event/${source.id}`,
        metadata: {
          source_event_id: source.id,
          source_watch_id: source.watch_id,
          mode: season.mode,
          participant_cutoff: season.eligible_until ?? season.ends_at,
          evidence_kind: evidence.kind,
          evidence_reference: evidence.reference ?? null,
        },
      });
    }
  }
  return desired;
}
function projectionRoots(userId, tmdbIds, seasonIds) {
  const tmdbFilter = tmdbIds === null ? "" : ` AND w.tmdb_id IN (${placeholders(tmdbIds)})`;
  const seasonFilter = seasonIds === null ? "" : ` AND e.season_id IN (${placeholders(seasonIds)})`;
  return db.prepare(`SELECT e.* FROM score_events e JOIN watches w ON w.id=e.watch_id
    JOIN seasons s ON s.id=e.season_id JOIN leagues l ON l.id=s.league_id
    WHERE e.user_id=? AND e.projection_source_event_id IS NOT NULL AND e.reverses_event_id IS NULL
      AND s.cancelled_at IS NULL AND s.finalized_at IS NULL AND l.archived_at IS NULL${tmdbFilter}${seasonFilter}
    ORDER BY e.season_id,e.projection_source_event_id,e.id`).all(userId, ...(tmdbIds ?? []), ...(seasonIds ?? []));
}
function chainLeaf(root) {
  let leaf = root;
  while (true) {
    const child = db.prepare("SELECT * FROM score_events WHERE reverses_event_id=?").get(leaf.id);
    if (!child) return leaf;
    leaf = child;
  }
}
function isProjected(root, leaf) {
  let depth = 0, row = leaf;
  while (row.id !== root.id) {
    depth += 1;
    row = db.prepare("SELECT * FROM score_events WHERE id=?").get(row.reverses_event_id);
    if (!row) throw new Error(`Broken score projection chain for event ${root.id}.`);
  }
  return depth % 2 === 0;
}
function leafEvidenceReference(root, leaf) {
  const metadata = parseMetadata(leaf.metadata_json);
  if (leaf.id === root.id) return metadata.evidence_reference ?? null;
  return metadata.projection_context?.evidence_reference ?? null;
}
function immutableProjectionMatches(root, item) {
  return root.user_id === item.source.user_id && root.watch_id === item.source.watch_id && root.season_id === item.season.id
    && root.projection_source_event_id === item.source.id && root.season_member_id === item.season.season_member_id
    && root.category === item.source.category && root.points === item.source.points && root.rule_version === item.source.rule_version
    && root.effective_at === item.source.effective_at && root.event_key === item.eventKey
    && parseMetadata(root.metadata_json).source_event_id === item.metadata.source_event_id
    && parseMetadata(root.metadata_json).source_watch_id === item.metadata.source_watch_id
    && parseMetadata(root.metadata_json).mode === item.metadata.mode;
}

export function reconcileSeasonScoresForUser(userId, options = {}) {
  const uid = positiveId(userId, "userId");
  const value = exactObject(options, "Season score options", USER_OPTION_KEYS);
  const tmdbIds = idArray(value.tmdbIds, "tmdbIds");
  const seasonIds = idArray(value.seasonIds, "seasonIds");
  const enforcePostEndGrace = value.enforcePostEndGrace === true;
  return db.transaction(() => {
    const frozenSeasonIds = requestedFrozenSeasonIds(uid, seasonIds);
    const desired = desiredFor(uid, tmdbIds, seasonIds, enforcePostEndGrace);
    const roots = projectionRoots(uid, tmdbIds, seasonIds);
    const existing = new Map(roots.map((root) => [`${root.season_id}:${root.projection_source_event_id}`, root]));
    let added = 0, reversed = 0, reactivated = 0, unchanged = 0;
    for (const [key, item] of desired) {
      const root = existing.get(key);
      if (!root) {
        awardScoreEvent({ eventKey: item.eventKey, userId: uid, watchId: item.source.watch_id,
          seasonId: item.season.id, projectionSourceEventId: item.source.id, seasonMemberId: item.season.season_member_id,
          category: item.source.category, points: item.source.points, ruleVersion: item.source.rule_version,
          metadata: item.metadata, effectiveAt: item.source.effective_at });
        added += 1;
        continue;
      }
      if (!immutableProjectionMatches(root, item)) throw new Error(`Existing season projection ${root.id} conflicts with its immutable source.`);
      let leaf = chainLeaf(root);
      const context = { evidence_kind: item.evidence.kind, evidence_reference: item.evidence.reference ?? null };
      if (!isProjected(root, leaf)) {
        reverseSeasonProjectionChainEvents({ userId: uid, eventIds: [leaf.id], reason: "season_projection_reactivated", context });
        reactivated += 1;
      } else if (leafEvidenceReference(root, leaf) !== context.evidence_reference) {
        [leaf] = reverseSeasonProjectionChainEvents({ userId: uid, eventIds: [leaf.id], reason: "season_projection_evidence_changed", context });
        reverseSeasonProjectionChainEvents({ userId: uid, eventIds: [leaf.id], reason: "season_projection_reactivated", context });
        reversed += 1;
        reactivated += 1;
      } else unchanged += 1;
    }
    for (const [key, root] of existing) {
      if (desired.has(key)) continue;
      const leaf = chainLeaf(root);
      if (isProjected(root, leaf)) { reverseSeasonProjectionChainEvents({ userId: uid, eventIds: [leaf.id], reason: "season_projection_no_longer_eligible" }); reversed += 1; }
      else unchanged += 1;
    }
    return { userId: uid, added, reversed, reactivated, unchanged, frozenSeasonIds };
  }).immediate();
}

export function reconcileSeasonBatch(seasonId, options = {}) {
  const sid = positiveId(seasonId, "seasonId");
  const value = exactObject(options, "Season batch options", BATCH_OPTION_KEYS);
  const afterUserId = positiveId(value.afterUserId, "afterUserId", { optional: true }) ?? 0;
  const limit = value.limit === undefined ? DEFAULT_BATCH_LIMIT : value.limit;
  const enforcePostEndGrace = value.enforcePostEndGrace === true;
  if (value.enforcePostEndGrace !== undefined && typeof value.enforcePostEndGrace !== "boolean") throw new TypeError("enforcePostEndGrace must be a boolean.");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer between 1 and 100.");
  return db.transaction(() => {
    const season = db.prepare(`SELECT s.cancelled_at,s.finalized_at,s.participants_locked_at,l.archived_at
      FROM seasons s JOIN leagues l ON l.id=s.league_id WHERE s.id=?`).get(sid);
    if (!season) throw new RangeError("Season not found.");
    if (season.cancelled_at != null || season.finalized_at != null || season.archived_at != null) {
      return { seasonId: sid, processed: 0, added: 0, reversed: 0, reactivated: 0, nextCursor: null, done: true, frozen: true, ready: true };
    }
    if (season.participants_locked_at == null) {
      return { seasonId: sid, processed: 0, added: 0, reversed: 0, reactivated: 0, nextCursor: null, done: true, frozen: false, ready: false };
    }
    const rows = db.prepare("SELECT user_id FROM season_members WHERE season_id=? AND user_id>? ORDER BY user_id LIMIT ?").all(sid, afterUserId, limit + 1);
    const page = rows.slice(0, limit);
    const totals = { added: 0, reversed: 0, reactivated: 0 };
    const failedUserIds = [];
    for (const row of page) {
      try {
        const result = reconcileSeasonScoresForUser(row.user_id, { seasonIds: [sid], enforcePostEndGrace });
        for (const key of Object.keys(totals)) totals[key] += result[key];
      } catch {
        failedUserIds.push(row.user_id);
      }
    }
    const done = rows.length <= limit;
    return { seasonId: sid, processed: page.length, failed: failedUserIds.length, failedUserIds, ...totals,
      counts: { added: totals.added, reversed: totals.reversed, reactivated: totals.reactivated },
      nextCursor: done || page.length === 0 ? null : page.at(-1).user_id, done, frozen: false, ready: true };
  }).immediate();
}


export function reconcileSeasonFully(seasonId, { limit = 100 } = {}) {
  const totals = { processed: 0, failed: 0, added: 0, reversed: 0, reactivated: 0 };
  let afterUserId;
  let last;
  do {
    last = reconcileSeasonBatch(seasonId, { ...(afterUserId === undefined ? {} : { afterUserId }), limit, enforcePostEndGrace: true });
    totals.processed += last.processed ?? 0;
    totals.failed += last.failed ?? 0;
    totals.added += last.added ?? 0;
    totals.reversed += last.reversed ?? 0;
    totals.reactivated += last.reactivated ?? 0;
    afterUserId = last.nextCursor ?? undefined;
  } while (last.ready && !last.frozen && !last.done && afterUserId !== undefined);
  return { ...last, ...totals, counts: { added: totals.added, reversed: totals.reversed, reactivated: totals.reactivated } };
}
