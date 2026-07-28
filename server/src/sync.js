// Provider API clients used by connection linking and sync. History reconciliation remains unchanged in Task 3.
import { db } from "./db.js";
import { watchPoints } from "./scoring.js";
import { providerJson, safeProviderFetch, plexHeaders } from "./providers.js";
import { PLEX_ALLOWED_ORIGINS } from "./config.js";

const toDay = (ts) => ts.slice(0, 10);
export async function importHistory(userId, service, items, getMovie) {
  const result = { imported: 0, verified: 0, skipped: 0, failed: 0, movies: [] };
  const sorted = [...items].filter((it) => it.tmdb_id && it.watched_at).sort((a, b) => (a.watched_at < b.watched_at ? -1 : 1));
  const seen = new Set();
  for (const item of sorted) {
    const dayKey = `${item.tmdb_id}:${toDay(item.watched_at)}`;
    if (seen.has(dayKey)) continue;
    seen.add(dayKey);
    const existing = db.prepare("SELECT id, source, watched_at FROM watches WHERE user_id = ? AND tmdb_id = ? ORDER BY watched_at DESC").all(userId, item.tmdb_id);
    const sameDay = existing.find((w) => toDay(w.watched_at) === toDay(item.watched_at));
    if (sameDay) {
      if (sameDay.source === "manual") { db.prepare("UPDATE watches SET source = ? WHERE id = ?").run(service, sameDay.id); result.verified++; }
      else result.skipped++;
      continue;
    }
    let movie;
    try { movie = await getMovie(item.tmdb_id); } catch { result.failed++; continue; }
    const { points, isRewatch } = watchPoints({ voteAverage: movie.vote_average, runtime: movie.runtime, priorWatches: existing.map((w) => w.watched_at) });
    db.prepare(`INSERT INTO watches (user_id,tmdb_id,title,poster_path,vote_average,runtime,release_date,genres,collection_id,collection_name,points,is_rewatch,source,watched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      userId, movie.id, movie.title, movie.poster_path, movie.vote_average, movie.runtime, movie.release_date,
      JSON.stringify((movie.genres || []).map((genre) => genre.name)), movie.belongs_to_collection?.id || null, movie.belongs_to_collection?.name || null,
      points, isRewatch ? 1 : 0, service, item.watched_at);
    result.imported++;
    if (!result.movies.includes(item.tmdb_id)) result.movies.push(item.tmdb_id);
  }
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
    for (const history of batch) { const tmdbId = history.movie?.ids?.tmdb; if (tmdbId && history.watched_at) items.push({ tmdb_id: tmdbId, watched_at: history.watched_at.replace("T", " ").replace(/(\.\d+)?Z$/, "") }); }
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
export async function plexWatchedMovies(serverUrl, token, expectedMachineId = null) {
  if (expectedMachineId) await plexValidate(serverUrl, token, expectedMachineId);
  const sections = await plexGet(serverUrl, token, "/library/sections");
  const movieSections = (sections?.MediaContainer?.Directory || []).filter((directory) => directory.type === "movie");
  const items = [];
  for (const section of movieSections) {
    for (let start = 0; ; start += 200) {
      const page = await plexGet(serverUrl, token, `/library/sections/${encodeURIComponent(section.key)}/all?type=1&includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=200`);
      const metadata = page?.MediaContainer?.Metadata || [];
      for (const video of metadata) {
        if (!video.viewCount || video.viewCount < 1) continue;
        const guid = (video.Guid || []).find((entry) => (entry.id || "").startsWith("tmdb://"));
        const tmdbId = guid ? Number.parseInt(guid.id.slice(7), 10) : 0;
        if (!tmdbId) continue;
        const watchedAt = video.lastViewedAt ? new Date(video.lastViewedAt * 1000).toISOString().replace("T", " ").slice(0, 19) : new Date().toISOString().replace("T", " ").slice(0, 19);
        items.push({ tmdb_id: tmdbId, watched_at: watchedAt });
      }
      if (metadata.length < 200) break;
    }
  }
  return items;
}
