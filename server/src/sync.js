import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { watchPoints } from "./scoring.js";
import { providerJson, safeProviderFetch, plexHeaders } from "./providers.js";
import { PLEX_ALLOWED_ORIGINS } from "./config.js";

const normalizeWatchedAt = (value) => new Date(String(value).replace(" ", "T") + (String(value).includes("Z") || /[+-]\d\d:\d\d$/.test(String(value)) ? "" : "Z")).toISOString().replace("T", " ").slice(0, 19);
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const stableJson = (value) => JSON.stringify(value);

export function recomputeUserWatchScores(userId, tmdbIds = null) {
  const affected = tmdbIds == null
    ? null
    : [...new Set((Array.isArray(tmdbIds) ? tmdbIds : [tmdbIds]).map(Number))]
        .filter((id) => Number.isInteger(id) && id > 0);
  if (affected && affected.length === 0) return;
  const scope = affected ? ` AND tmdb_id IN (${affected.map(() => "?").join(",")})` : "";
  const rows = db.prepare(`SELECT id,tmdb_id,vote_average,runtime,watched_at
    FROM watches WHERE user_id=?${scope} ORDER BY watched_at ASC,id ASC`).all(userId, ...(affected || []));
  const priorByMovie = new Map();
  const update = db.prepare("UPDATE watches SET points=?,is_rewatch=? WHERE id=?");
  for (const row of rows) {
    const prior = priorByMovie.get(row.tmdb_id) || [];
    const score = watchPoints({ voteAverage: row.vote_average, runtime: row.runtime, priorWatches: prior, watchedAt: row.watched_at });
    update.run(score.points, score.isRewatch ? 1 : 0, row.id);
    prior.push(row.watched_at);
    priorByMovie.set(row.tmdb_id, prior);
  }
}

function namespacedEventId(service, connectionId, eventId) {
  return `${service}:${connectionId}:${String(eventId)}`;
}

export async function importHistory(userId, service, items, getMovie, { connectionId = `legacy:${service}` } = {}) {
  const result = { imported: 0, verified: 0, skipped: 0, failed: 0, movies: [] };
  const normalized = [];
  for (const item of items || []) {
    if (!item.tmdb_id || !item.watched_at || item.event_id == null) { result.failed++; continue; }
    try {
      normalized.push({
        tmdb_id: Number(item.tmdb_id),
        watched_at: normalizeWatchedAt(item.watched_at),
        provider_event_id: namespacedEventId(service, connectionId, item.event_id),
      });
    } catch { result.failed++; }
  }
  normalized.sort((a, b) => a.watched_at.localeCompare(b.watched_at) || a.provider_event_id.localeCompare(b.provider_event_id));

  // Provider and TMDB work finishes before the short write transaction.
  const movieById = new Map();
  for (const tmdbId of [...new Set(normalized.map((item) => item.tmdb_id))]) {
    try { movieById.set(tmdbId, await getMovie(tmdbId)); }
    catch { movieById.set(tmdbId, null); }
  }

  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO watches
      (user_id,tmdb_id,title,poster_path,vote_average,runtime,release_date,genres,collection_id,collection_name,
       points,is_rewatch,source,watched_at,provider_service,provider_connection_id,provider_event_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,provider_service,provider_connection_id,provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING`);
    for (const item of normalized) {
      const movie = movieById.get(item.tmdb_id);
      if (!movie) { result.failed++; continue; }
      const info = insert.run(
        userId, movie.id, movie.title, movie.poster_path, movie.vote_average, movie.runtime, movie.release_date,
        JSON.stringify((movie.genres || []).map((genre) => genre.name)), movie.belongs_to_collection?.id || null,
        movie.belongs_to_collection?.name || null, 0, 0, service, item.watched_at, service, connectionId, item.provider_event_id,
      );
      if (info.changes) {
        result.imported++;
        if (!result.movies.includes(item.tmdb_id)) result.movies.push(item.tmdb_id);
      } else result.skipped++;
    }
    if (result.imported) recomputeUserWatchScores(userId, result.movies);
  })();
  return result;
}

const TRAKT_BASE = process.env.TRAKT_BASE_URL || "https://api.trakt.tv";
export const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET || "";
const testLoopback = process.env.NODE_ENV === "test";
const policy = (origin, plex = false) => ({ allowedOrigins: [origin], allowedPrivateOrigins: plex && PLEX_ALLOWED_ORIGINS.includes(origin) ? [origin] : [], allowTestLoopback: testLoopback });
export const traktConfigured = () => !!(TRAKT_CLIENT_ID && TRAKT_CLIENT_SECRET);
function traktHeaders(token) { return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "trakt-api-version": "2", "trakt-api-key": TRAKT_CLIENT_ID }; }
async function traktPost(path, body) { return providerJson(TRAKT_BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, policy(new URL(TRAKT_BASE).origin)); }
export const traktDeviceCode = () => traktPost("/oauth/device/code", { client_id: TRAKT_CLIENT_ID });
export async function traktDeviceToken(deviceCode) {
  const response = await safeProviderFetch(TRAKT_BASE + "/oauth/device/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: deviceCode, client_id: TRAKT_CLIENT_ID, client_secret: TRAKT_CLIENT_SECRET }) }, policy(new URL(TRAKT_BASE).origin));
  if (response.status === 400) return { pending: true };
  if (!response.ok) { const error = new Error(response.status === 410 || response.status === 404 ? "The code expired. Start over to get a new one." : response.status === 409 ? "That code was already used." : `Trakt error ${response.status}`); error.status = 400; throw error; }
  return response.json();
}
export async function traktProfile(token) { return providerJson(TRAKT_BASE + "/users/settings", { headers: traktHeaders(token) }, policy(new URL(TRAKT_BASE).origin)); }
export async function traktUsername(token) { return (await traktProfile(token))?.user?.username || null; }
export async function traktHistory(token) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const response = await safeProviderFetch(`${TRAKT_BASE}/sync/history/movies?page=${page}&limit=100`, { headers: traktHeaders(token) }, policy(new URL(TRAKT_BASE).origin));
    if (!response.ok) { const error = new Error(`Trakt error ${response.status}`); error.status = response.status === 401 ? 401 : 502; throw error; }
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("Trakt returned invalid history.");
    for (const history of batch) {
      const tmdbId = history.movie?.ids?.tmdb;
      if (tmdbId && history.watched_at && history.id != null) items.push({ tmdb_id: tmdbId, watched_at: history.watched_at, event_id: String(history.id) });
    }
    if (batch.length < 100) break;
  }
  return items;
}
export const traktRefresh = (refreshToken) => traktPost("/oauth/token", { refresh_token: refreshToken, client_id: TRAKT_CLIENT_ID, client_secret: TRAKT_CLIENT_SECRET, grant_type: "refresh_token" });
export async function traktHistoryWithRefresh(credentials, expiresAt) {
  let current = { ...credentials };
  async function refreshAndRetry() {
    const token = await traktRefresh(current.refreshToken);
    current = { accessToken: token.access_token, refreshToken: token.refresh_token || current.refreshToken };
    const nextExpiry = new Date((Number(token.created_at || Math.floor(Date.now() / 1000)) + Number(token.expires_in || 3600)) * 1000).toISOString();
    return { items: await traktHistory(current.accessToken), credentials: current, expiresAt: nextExpiry };
  }
  if ((!expiresAt || new Date(expiresAt).getTime() <= Date.now() + 60000) && current.refreshToken) return refreshAndRetry();
  try { return { items: await traktHistory(current.accessToken), credentials: null, expiresAt }; }
  catch (error) { if (error.status !== 401 || !current.refreshToken) throw error; return refreshAndRetry(); }
}

export function normalizePlexUrl(raw) {
  try { const url = new URL(String(raw)); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null; return url.origin; } catch { return null; }
}
async function plexGet(serverUrl, token, path) {
  const origin = new URL(serverUrl).origin;
  const response = await safeProviderFetch(serverUrl + path, { headers: plexHeaders(token) }, policy(origin, true));
  if (!response.ok) { const error = new Error(response.status === 401 ? "Plex rejected the token." : `Plex error ${response.status}`); error.status = response.status === 401 ? 401 : 502; throw error; }
  return response.json();
}
export async function plexValidate(serverUrl, token, expectedMachineId = null) {
  const data = await plexGet(serverUrl, token, "/identity");
  const identity = data?.MediaContainer || data || {};
  const machineId = String(identity.machineIdentifier || identity.machine_identifier || "");
  if (expectedMachineId && machineId !== expectedMachineId) { const error = new Error("Plex server identity changed or is not allowed."); error.status = 403; throw error; }
  return { name: identity.friendlyName || "Plex Media Server", machineId };
}
function tmdbFromGuids(item) {
  const guids = [...(Array.isArray(item?.Guid) ? item.Guid.map((entry) => entry?.id) : []), item?.guid, item?.Guid];
  for (const raw of guids.filter((value) => typeof value === "string")) {
    const match = raw.match(/(?:tmdb:\/\/|themoviedb:\/\/|com\.plexapp\.agents\.themoviedb:\/\/)(\d+)/i);
    if (match) return Number(match[1]);
  }
  return null;
}
export async function plexWatchedMovies(
  serverUrl,
  token,
  expectedMachineId = null,
  { accountId = null } = {},
) {
  if (expectedMachineId) await plexValidate(serverUrl, token, expectedMachineId);
  const items = [];
  const metadataCache = new Map();
  const observedAccountIds = new Set();
  let metadataLookups = 0;
  for (let start = 0, pageNumber = 0; pageNumber < 50; start += 200, pageNumber++) {
    const query = new URLSearchParams({
      type: "1",
      sort: "viewedAt:asc",
      includeGuids: "1",
      "X-Plex-Container-Start": String(start),
      "X-Plex-Container-Size": "200",
    });
    if (accountId != null) query.set("accountID", String(accountId));
    const page = await plexGet(serverUrl, token, `/status/sessions/history/all?${query}`);
    const history = page?.MediaContainer?.Metadata || [];
    if (!Array.isArray(history)) throw new Error("Plex returned invalid playback history.");
    for (const event of history) {
      if (!event.viewedAt || !event.ratingKey) continue;
      const eventAccountId = event.accountID ?? event.accountId;
      if (eventAccountId == null) {
        throw new Error("Plex history did not identify the viewing account.");
      }
      observedAccountIds.add(String(eventAccountId));
      if (accountId != null && String(eventAccountId) !== String(accountId)) {
        throw new Error("Plex returned history for an unexpected account.");
      }
      if (accountId == null && observedAccountIds.size > 1) {
        throw new Error("Plex returned history for multiple Plex accounts; configure an explicit history account ID.");
      }
      let tmdbId = tmdbFromGuids(event);
      const ratingKey = String(event.ratingKey);
      if (!tmdbId) {
        if (metadataCache.has(ratingKey)) tmdbId = metadataCache.get(ratingKey);
        else if (metadataLookups < 500) {
          metadataLookups++;
          const metadata = await plexGet(
            serverUrl,
            token,
            `/library/metadata/${encodeURIComponent(ratingKey)}?includeGuids=1`,
          );
          tmdbId = tmdbFromGuids(metadata?.MediaContainer?.Metadata?.[0]);
          metadataCache.set(ratingKey, tmdbId || null);
        }
      }
      if (!tmdbId) continue;
      const eventKey = event.historyKey || event.history_key || event.id ||
        `${ratingKey}:${event.viewedAt}:${eventAccountId}:${event.deviceID || ""}`;
      items.push({
        tmdb_id: tmdbId,
        watched_at: new Date(Number(event.viewedAt) * 1000).toISOString(),
        event_id: String(eventKey),
      });
    }
    if (history.length < 200) break;
  }
  return items;
}

function currentCandidates(targetUserId, placeholderDate) {
  const manuals = db.prepare(`SELECT id,tmdb_id,title,watched_at FROM watches
    WHERE user_id=? AND source='manual' AND date(watched_at)=? ORDER BY tmdb_id,id`).all(targetUserId, placeholderDate);
  const providers = db.prepare(`SELECT id,tmdb_id,title,watched_at,source,provider_service,provider_connection_id,provider_event_id
    FROM watches WHERE user_id=? AND provider_event_id IS NOT NULL AND date(watched_at)<=?
    ORDER BY tmdb_id,watched_at DESC,provider_event_id DESC,id DESC`).all(targetUserId, placeholderDate);
  const providerByMovie = new Map();
  for (const row of providers) {
    const list = providerByMovie.get(row.tmdb_id) || [];
    list.push(row); providerByMovie.set(row.tmdb_id, list);
  }
  const used = new Map();
  const candidates = [];
  for (const manual of manuals) {
    const list = providerByMovie.get(manual.tmdb_id) || [];
    const index = used.get(manual.tmdb_id) || 0;
    const provider = list[index];
    if (!provider) continue;
    used.set(manual.tmdb_id, index + 1);
    const candidateId = digest(`${targetUserId}|${manual.id}|${provider.id}|${provider.provider_event_id}`);
    candidates.push({
      candidate_id: candidateId, manual_watch_id: manual.id, provider_watch_id: provider.id,
      tmdb_id: manual.tmdb_id, title: manual.title, manual_watched_at: manual.watched_at,
      provider_watched_at: provider.watched_at, source: provider.source,
      provider_service: provider.provider_service, provider_connection_id: provider.provider_connection_id,
      provider_event_id: provider.provider_event_id,
    });
  }
  return candidates;
}

export function previewPlaceholderReconciliation(actorUserId, targetUserId, placeholderDate = process.env.ONBOARDING_PLACEHOLDER_DATE || new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(placeholderDate)) { const error = new Error("Placeholder date must use YYYY-MM-DD."); error.status = 400; throw error; }
  const candidates = currentCandidates(targetUserId, placeholderDate);
  const previewHash = digest(stableJson({ targetUserId, placeholderDate, candidates }));
  const nonce = randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO reconciliation_previews
    (nonce_hash,preview_hash,actor_user_id,target_user_id,placeholder_date,candidates_json,expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(digest(nonce), previewHash, actorUserId, targetUserId, placeholderDate, stableJson(candidates), new Date(Date.now() + 15 * 60 * 1000).toISOString());
  return { nonce, preview_hash: previewHash, placeholder_date: placeholderDate, candidates: candidates.map(({ provider_service: _ps, provider_connection_id: _pc, provider_event_id: _pe, ...safe }) => safe) };
}

export function applyPlaceholderReconciliation(actorUserId, targetUserId, { nonce, previewHash, candidateIds, ip = null }) {
  if (!nonce || !previewHash || !Array.isArray(candidateIds) || !candidateIds.length || new Set(candidateIds).size !== candidateIds.length) {
    const error = new Error("Explicit unique candidate IDs, nonce, and preview hash are required."); error.status = 400; throw error;
  }
  const apply = db.transaction(() => {
    const preview = db.prepare("SELECT * FROM reconciliation_previews WHERE nonce_hash=?").get(digest(nonce));
    if (!preview || preview.actor_user_id !== actorUserId || preview.target_user_id !== targetUserId || preview.preview_hash !== previewHash || preview.consumed_at || new Date(preview.expires_at).getTime() <= Date.now()) {
      const error = new Error("Reconciliation preview is invalid, expired, or already used."); error.status = 409; throw error;
    }
    const snapshot = JSON.parse(preview.candidates_json);
    const current = currentCandidates(targetUserId, preview.placeholder_date);
    const currentHash = digest(stableJson({ targetUserId, placeholderDate: preview.placeholder_date, candidates: current }));
    if (currentHash !== preview.preview_hash) { const error = new Error("Reconciliation preview is stale; preview again."); error.status = 409; throw error; }
    const byId = new Map(snapshot.map((candidate) => [candidate.candidate_id, candidate]));
    const selected = candidateIds.map((id) => byId.get(id));
    if (selected.some((candidate) => !candidate)) { const error = new Error("A selected candidate was not in this preview."); error.status = 400; throw error; }

    const consumed = db.prepare(`UPDATE reconciliation_previews SET consumed_at=datetime('now')
      WHERE nonce_hash=? AND consumed_at IS NULL AND expires_at>datetime('now')`).run(digest(nonce));
    if (consumed.changes !== 1) {
      const error = new Error("Reconciliation preview is invalid, expired, or already used.");
      error.status = 409;
      throw error;
    }

    const removeProvider = db.prepare("DELETE FROM watches WHERE id=? AND user_id=? AND provider_event_id=?");
    const updateManual = db.prepare(`UPDATE watches SET watched_at=?,source=?,provider_service=?,provider_connection_id=?,provider_event_id=?
      WHERE id=? AND user_id=? AND source='manual' AND watched_at=?`);
    for (const candidate of selected) {
      if (removeProvider.run(candidate.provider_watch_id, targetUserId, candidate.provider_event_id).changes !== 1) throw Object.assign(new Error("Reconciliation preview is stale; preview again."), { status: 409 });
      if (updateManual.run(candidate.provider_watched_at, candidate.source, candidate.provider_service, candidate.provider_connection_id, candidate.provider_event_id, candidate.manual_watch_id, targetUserId, candidate.manual_watched_at).changes !== 1) throw Object.assign(new Error("Reconciliation preview is stale; preview again."), { status: 409 });
    }
    recomputeUserWatchScores(targetUserId, selected.map((candidate) => candidate.tmdb_id));
    const detail = stableJson({
      actor_user_id: actorUserId,
      target_user_id: targetUserId,
      row_ids: selected.map((c) => c.manual_watch_id),
      provider_row_ids: selected.map((c) => c.provider_watch_id),
      timestamps: selected.map((c) => ({ before: c.manual_watched_at, after: c.provider_watched_at })),
    });
    db.prepare(`INSERT INTO audit_log (user_id,action,target_id,detail,ip) VALUES (?,'reconcile_placeholders',?,?,?)`).run(actorUserId, targetUserId, detail, ip);
    return { reconciled: selected.length, row_ids: selected.map((candidate) => candidate.manual_watch_id) };
  });
  return apply.immediate();
}
