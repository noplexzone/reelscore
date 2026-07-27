// Watch-history import from linked services (Plex / Trakt).
//
// Imported watches carry their service as `source`, which the UI renders as a
// verified badge: the service's history is proof the film was really watched,
// as opposed to a manually logged entry. If the user already logged a film by
// hand and the service's history has it on the same calendar day, the manual
// entry is upgraded ("verified") in place rather than duplicated.

import { db } from "./db.js";
import { watchPoints } from "./scoring.js";

const toDay = (ts) => ts.slice(0, 10);

// items: [{ tmdb_id, watched_at: "YYYY-MM-DD HH:MM:SS" (UTC) }]
// getMovie: async (tmdbId) => TMDB movie details (with credits appended)
export async function importHistory(userId, service, items, getMovie) {
  const result = { imported: 0, verified: 0, skipped: 0, failed: 0, movies: [] };

  // Oldest first so rewatch logic sees earlier plays as prior watches.
  const sorted = [...items]
    .filter((it) => it.tmdb_id && it.watched_at)
    .sort((a, b) => (a.watched_at < b.watched_at ? -1 : 1));

  const seen = new Set(); // dedupe within the payload: one play per film per day
  for (const item of sorted) {
    const dayKey = `${item.tmdb_id}:${toDay(item.watched_at)}`;
    if (seen.has(dayKey)) continue;
    seen.add(dayKey);

    const existing = db
      .prepare(
        "SELECT id, source, watched_at FROM watches WHERE user_id = ? AND tmdb_id = ? ORDER BY watched_at DESC"
      )
      .all(userId, item.tmdb_id);

    const sameDay = existing.find((w) => toDay(w.watched_at) === toDay(item.watched_at));
    if (sameDay) {
      if (sameDay.source === "manual") {
        db.prepare("UPDATE watches SET source = ? WHERE id = ?").run(service, sameDay.id);
        result.verified++;
      } else {
        result.skipped++; // already synced
      }
      continue;
    }

    let m;
    try {
      m = await getMovie(item.tmdb_id);
    } catch {
      result.failed++; // film unknown to TMDB (or hiccup) — skip it
      continue;
    }

    const { points, isRewatch } = watchPoints({
      voteAverage: m.vote_average,
      runtime: m.runtime,
      priorWatches: existing.map((w) => w.watched_at),
    });

    db.prepare(
      `INSERT INTO watches
       (user_id, tmdb_id, title, poster_path, vote_average, runtime, release_date,
        genres, collection_id, collection_name, points, is_rewatch, source, watched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      m.id,
      m.title,
      m.poster_path,
      m.vote_average,
      m.runtime,
      m.release_date,
      JSON.stringify((m.genres || []).map((g) => g.name)),
      m.belongs_to_collection?.id || null,
      m.belongs_to_collection?.name || null,
      points,
      isRewatch ? 1 : 0,
      service,
      item.watched_at
    );
    result.imported++;
    if (!result.movies.includes(item.tmdb_id)) result.movies.push(item.tmdb_id);
  }

  return result;
}

// ---- Trakt ----------------------------------------------------------------

const TRAKT_BASE = process.env.TRAKT_BASE_URL || "https://api.trakt.tv";
export const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET || "";
export const traktConfigured = () => !!(TRAKT_CLIENT_ID && TRAKT_CLIENT_SECRET);

async function traktPost(path, body) {
  const res = await fetch(TRAKT_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Trakt error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function traktHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "trakt-api-version": "2",
    "trakt-api-key": TRAKT_CLIENT_ID,
  };
}

export const traktDeviceCode = () =>
  traktPost("/oauth/device/code", { client_id: TRAKT_CLIENT_ID });

// Resolves to tokens once the user has approved the code; a 400 from Trakt
// means "still pending" and is surfaced as { pending: true }.
export async function traktDeviceToken(deviceCode) {
  const res = await fetch(TRAKT_BASE + "/oauth/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: deviceCode,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
    }),
  });
  if (res.status === 400) return { pending: true };
  if (!res.ok) {
    const err = new Error(
      res.status === 410 || res.status === 404
        ? "The code expired. Start over to get a new one."
        : res.status === 409
        ? "That code was already used."
        : `Trakt error ${res.status}`
    );
    err.status = 400;
    throw err;
  }
  return res.json();
}

export async function traktUsername(token) {
  const res = await fetch(TRAKT_BASE + "/users/settings", { headers: traktHeaders(token) });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.user?.username || null;
}

export async function traktHistory(token) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `${TRAKT_BASE}/sync/history/movies?page=${page}&limit=100`,
      { headers: traktHeaders(token) }
    );
    if (!res.ok) {
      const err = new Error(`Trakt error ${res.status}`);
      err.status = res.status === 401 ? 401 : 502;
      throw err;
    }
    const batch = await res.json();
    for (const h of batch) {
      const tmdbId = h.movie?.ids?.tmdb;
      if (tmdbId && h.watched_at) {
        items.push({
          tmdb_id: tmdbId,
          watched_at: h.watched_at.replace("T", " ").replace(/(\.\d+)?Z$/, ""),
        });
      }
    }
    if (batch.length < 100) break;
  }
  return items;
}

// ---- Plex -----------------------------------------------------------------

export function normalizePlexUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

async function plexGet(serverUrl, token, path) {
  const res = await fetch(serverUrl + path, {
    headers: { Accept: "application/json", "X-Plex-Token": token },
  });
  if (!res.ok) {
    const err = new Error(
      res.status === 401 ? "Plex rejected the token." : `Plex error ${res.status}`
    );
    err.status = res.status === 401 ? 401 : 502;
    throw err;
  }
  return res.json();
}

export async function plexValidate(serverUrl, token) {
  const data = await plexGet(serverUrl, token, "/identity");
  return data?.MediaContainer?.friendlyName || "Plex Media Server";
}

// All watched movies (viewCount > 0) across every movie library, with the
// last-viewed time and the TMDB id from the item's Guid entries.
export async function plexWatchedMovies(serverUrl, token) {
  const sections = await plexGet(serverUrl, token, "/library/sections");
  const movieSections = (sections?.MediaContainer?.Directory || []).filter(
    (d) => d.type === "movie"
  );
  const items = [];
  for (const section of movieSections) {
    for (let start = 0; ; start += 200) {
      const page = await plexGet(
        serverUrl,
        token,
        `/library/sections/${section.key}/all?type=1&includeGuids=1` +
          `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=200`
      );
      const metadata = page?.MediaContainer?.Metadata || [];
      for (const v of metadata) {
        if (!v.viewCount || v.viewCount < 1) continue;
        const guid = (v.Guid || []).find((g) => (g.id || "").startsWith("tmdb://"));
        if (!guid) continue;
        const tmdbId = parseInt(guid.id.slice("tmdb://".length), 10);
        if (!tmdbId) continue;
        const at = v.lastViewedAt
          ? new Date(v.lastViewedAt * 1000).toISOString().replace("T", " ").slice(0, 19)
          : new Date().toISOString().replace("T", " ").slice(0, 19);
        items.push({ tmdb_id: tmdbId, watched_at: at });
      }
      if (metadata.length < 200) break;
    }
  }
  return items;
}
