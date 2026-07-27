import { Router } from "express";
import { db } from "../db.js";
import { movieDetails } from "../tmdb.js";
import { evaluate, checkPersonCompletion } from "../achievements.js";
import { notablePeopleInMovie } from "../people.js";
import {
  importHistory,
  traktConfigured, traktDeviceCode, traktDeviceToken, traktUsername, traktHistory,
  normalizePlexUrl, plexValidate, plexWatchedMovies,
} from "../sync.js";

export const connections = Router();

const getConn = (userId, service) =>
  db.prepare("SELECT * FROM connections WHERE user_id = ? AND service = ?").get(userId, service);

function connSummary(userId) {
  const rows = db.prepare("SELECT * FROM connections WHERE user_id = ?").all(userId);
  const by = Object.fromEntries(rows.map((r) => [r.service, r]));
  return {
    trakt: {
      configured: traktConfigured(),
      linked: !!by.trakt,
      username: by.trakt?.service_username || null,
      last_synced_at: by.trakt?.last_synced_at || null,
    },
    plex: {
      linked: !!by.plex,
      server_url: by.plex?.server_url || null,
      server_name: by.plex?.service_username || null,
      last_synced_at: by.plex?.last_synced_at || null,
    },
  };
}

connections.get("/", (req, res) => res.json(connSummary(req.user.id)));

// ---- Trakt (OAuth device flow) -------------------------------------------
connections.post("/trakt/init", async (req, res, next) => {
  if (!traktConfigured()) {
    return res.status(503).json({
      error: "Trakt isn't configured on this server. Set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET.",
    });
  }
  try {
    const d = await traktDeviceCode();
    res.json({
      device_code: d.device_code,
      user_code: d.user_code,
      verification_url: d.verification_url,
      interval: d.interval || 5,
      expires_in: d.expires_in || 600,
    });
  } catch (e) {
    next(e);
  }
});

connections.post("/trakt/exchange", async (req, res, next) => {
  const deviceCode = (req.body?.device_code || "").toString();
  if (!deviceCode) return res.status(400).json({ error: "device_code is required." });
  try {
    const tok = await traktDeviceToken(deviceCode);
    if (tok.pending) return res.status(202).json({ pending: true });
    const username = await traktUsername(tok.access_token);
    db.prepare(
      `INSERT INTO connections (user_id, service, access_token, refresh_token, service_username)
       VALUES (?, 'trakt', ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         service_username = excluded.service_username,
         connected_at = datetime('now')`
    ).run(req.user.id, tok.access_token, tok.refresh_token || null, username);
    res.json({ linked: true, username });
  } catch (e) {
    next(e);
  }
});

// ---- Plex (server URL + token) -------------------------------------------
connections.post("/plex", async (req, res, next) => {
  const serverUrl = normalizePlexUrl(req.body?.server_url);
  const token = (req.body?.token || "").toString().trim();
  if (!serverUrl) return res.status(400).json({ error: "Enter a valid http(s) server URL." });
  if (!token) return res.status(400).json({ error: "A Plex token is required." });
  try {
    const serverName = await plexValidate(serverUrl, token);
    db.prepare(
      `INSERT INTO connections (user_id, service, access_token, server_url, service_username)
       VALUES (?, 'plex', ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET
         access_token = excluded.access_token,
         server_url = excluded.server_url,
         service_username = excluded.service_username,
         connected_at = datetime('now')`
    ).run(req.user.id, token, serverUrl, serverName);
    res.json({ linked: true, server_name: serverName });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: e.message });
    next(e);
  }
});

// ---- Sync + unlink --------------------------------------------------------
connections.post("/:service/sync", async (req, res, next) => {
  const service = req.params.service;
  if (service !== "plex" && service !== "trakt")
    return res.status(400).json({ error: "Unknown service." });
  const conn = getConn(req.user.id, service);
  if (!conn) return res.status(404).json({ error: `Link ${service} first.` });

  try {
    const items =
      service === "trakt"
        ? await traktHistory(conn.access_token)
        : await plexWatchedMovies(conn.server_url, conn.access_token);

    const result = await importHistory(req.user.id, service, items, movieDetails);

    // Evaluate achievements over everything that just landed.
    const newAchievements = [];
    const seenKeys = new Set();
    const collect = (list) => {
      for (const a of list || []) {
        if (!seenKeys.has(a.key)) { seenKeys.add(a.key); newAchievements.push(a); }
      }
    };
    const collectionIds = new Set();
    const personIds = new Set();
    for (const tmdbId of result.movies) {
      try {
        const m = await movieDetails(tmdbId);
        if (m.belongs_to_collection?.id) collectionIds.add(m.belongs_to_collection.id);
        for (const p of notablePeopleInMovie(m.credits)) personIds.add(p.id);
      } catch {}
    }
    collect(await evaluate(req.user.id, {}));
    for (const cid of collectionIds) {
      collect(await evaluate(req.user.id, { collection_id: cid }));
    }
    for (const pid of personIds) {
      try {
        const a = await checkPersonCompletion(req.user.id, pid);
        if (a) collect([a]);
      } catch {}
    }

    db.prepare(
      "UPDATE connections SET last_synced_at = datetime('now') WHERE user_id = ? AND service = ?"
    ).run(req.user.id, service);

    res.json({
      imported: result.imported,
      verified: result.verified,
      skipped: result.skipped,
      failed: result.failed,
      new_achievements: newAchievements,
    });
  } catch (e) {
    if (e.status === 401)
      return res.status(401).json({ error: `${service} rejected the stored credentials — re-link and try again.` });
    next(e);
  }
});

connections.delete("/:service", (req, res) => {
  const service = req.params.service;
  if (service !== "plex" && service !== "trakt")
    return res.status(400).json({ error: "Unknown service." });
  db.prepare("DELETE FROM connections WHERE user_id = ? AND service = ?").run(req.user.id, service);
  res.json({ ok: true });
});
