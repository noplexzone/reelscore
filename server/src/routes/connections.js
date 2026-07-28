import { Router } from "express";
import { db } from "../db.js";
import { movieDetails } from "../tmdb.js";
import { evaluate, checkPersonCompletion } from "../achievements.js";
import { notablePeopleInMovie } from "../people.js";
import { IS_HOSTED } from "../config.js";
import { ACTIVE_CREDENTIAL_KEY_ID, credentialEnvelopeKeyId, decryptJson, encryptJson } from "../providers.js";
import { importHistory, traktConfigured, traktDeviceCode, traktDeviceToken, traktProfile, traktHistoryWithRefresh, normalizePlexUrl, plexValidate, plexWatchedMovies } from "../sync.js";

export const connections = Router();
const getConn = (userId, service) => db.prepare("SELECT * FROM connections WHERE user_id=? AND service=?").get(userId, service);
const context = (userId, service) => ({ userId, connectionId: `${userId}:${service}`, provider: service, field: "credentials" });
const syncLocks = new Map();
async function withConnectionLock(key, task) {
  const previous = syncLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  syncLocks.set(key, current);
  try { return await current; }
  finally { if (syncLocks.get(key) === current) syncLocks.delete(key); }
}
function eventConnectionId(conn) {
  const identity = conn.provider_identity_id
    ? db.prepare("SELECT provider_user_id FROM provider_identities WHERE id=?").get(conn.provider_identity_id)
    : null;
  const subject = identity?.provider_user_id || `legacy-user-${conn.user_id}`;
  return conn.service === "plex" ? `${conn.server_machine_id || "unverified-server"}:${subject}` : subject;
}
function credentials(conn) {
  if (conn.credentials_encrypted) {
    const aad = context(conn.user_id, conn.service);
    const value = decryptJson(conn.credentials_encrypted, aad);
    if (credentialEnvelopeKeyId(conn.credentials_encrypted) !== ACTIVE_CREDENTIAL_KEY_ID) {
      db.prepare("UPDATE connections SET credentials_encrypted=? WHERE user_id=? AND service=?")
        .run(encryptJson(value, aad), conn.user_id, conn.service);
    }
    return value;
  }
  if (IS_HOSTED) throw new Error("Hosted provider credentials are not encrypted.");
  return { accessToken: conn.access_token, refreshToken: conn.refresh_token, token: conn.access_token };
}
function connSummary(userId) {
  const rows = db.prepare("SELECT service,service_username,last_synced_at,server_machine_id FROM connections WHERE user_id=?").all(userId);
  const by = Object.fromEntries(rows.map((row) => [row.service, row]));
  return {
    app_mode: IS_HOSTED ? "hosted" : "self_hosted",
    trakt: { configured: traktConfigured(), linked: !!by.trakt, username: by.trakt?.service_username || null, last_synced_at: by.trakt?.last_synced_at || null },
    plex: { linked: !!by.plex, server_name: by.plex?.service_username || null, machine_id: by.plex?.server_machine_id || null, last_synced_at: by.plex?.last_synced_at || null },
  };
}
connections.get("/", (req, res) => res.set("Cache-Control", "no-store").json(connSummary(req.user.id)));

connections.post("/trakt/init", async (_req, res, next) => {
  if (!traktConfigured()) return res.status(503).json({ error: "Trakt is not configured on this server." });
  try { const device = await traktDeviceCode(); res.set("Cache-Control", "no-store").json({ device_code: device.device_code, user_code: device.user_code, verification_url: device.verification_url, interval: device.interval || 5, expires_in: Math.min(device.expires_in || 600, 600) }); }
  catch (error) { next(error); }
});
connections.post("/trakt/exchange", async (req, res, next) => {
  const deviceCode = String(req.body?.device_code || "");
  if (!deviceCode || deviceCode.length > 512) return res.status(400).json({ error: "device_code is required." });
  try {
    const token = await traktDeviceToken(deviceCode);
    if (token.pending) return res.status(202).set("Cache-Control", "no-store").json({ pending: true });
    const profile = await traktProfile(token.access_token);
    const providerId = profile?.user?.ids?.trakt;
    if (providerId == null) throw new Error("Trakt did not return an immutable identity.");
    const expiresAt = token.expires_in ? new Date((Number(token.created_at || Math.floor(Date.now() / 1000)) + Number(token.expires_in)) * 1000).toISOString() : null;
    db.transaction(() => {
      const existing = db.prepare("SELECT * FROM provider_identities WHERE provider='trakt' AND provider_user_id=?").get(String(providerId));
      if (existing && existing.user_id !== req.user.id) { const error = new Error("That Trakt account is already linked."); error.status = 409; throw error; }
      const identityId = existing?.id || Number(db.prepare("INSERT INTO provider_identities (provider,provider_user_id,user_id,display_name) VALUES ('trakt',?,?,?)").run(String(providerId), req.user.id, profile.user.username || null).lastInsertRowid);
      const encrypted = encryptJson({ accessToken: token.access_token, refreshToken: token.refresh_token || null }, context(req.user.id, "trakt"));
      db.prepare(`INSERT INTO connections (user_id,service,access_token,refresh_token,service_username,credentials_encrypted,provider_identity_id,token_expires_at) VALUES (?,'trakt',NULL,NULL,?,?,?,?) ON CONFLICT(user_id,service) DO UPDATE SET access_token=NULL,refresh_token=NULL,service_username=excluded.service_username,credentials_encrypted=excluded.credentials_encrypted,provider_identity_id=excluded.provider_identity_id,token_expires_at=excluded.token_expires_at,connected_at=datetime('now')`).run(req.user.id, profile.user.username || null, encrypted, identityId, expiresAt);
    })();
    res.set("Cache-Control", "no-store").json({ linked: true, username: profile.user.username || null });
  } catch (error) { next(error); }
});

connections.post("/plex", async (req, res, next) => {
  if (IS_HOSTED) return res.status(403).json({ error: "Hosted Plex connections must use secure Plex sign-in and discovered resources." });
  const serverUrl = normalizePlexUrl(req.body?.server_url);
  const token = String(req.body?.token || "").trim();
  if (!serverUrl || !token) return res.status(400).json({ error: "A valid server URL and token are required." });
  try {
    const identity = await plexValidate(serverUrl, token);
    db.prepare(`INSERT INTO connections (user_id,service,access_token,server_url,service_username,credentials_encrypted,server_machine_id) VALUES (?,'plex',NULL,?,?,?,?) ON CONFLICT(user_id,service) DO UPDATE SET access_token=NULL,server_url=excluded.server_url,service_username=excluded.service_username,credentials_encrypted=excluded.credentials_encrypted,server_machine_id=excluded.server_machine_id,connected_at=datetime('now')`).run(req.user.id, serverUrl, identity.name, encryptJson({ token }, context(req.user.id, "plex")), identity.machineId || null);
    res.json({ linked: true, server_name: identity.name });
  } catch (error) { next(error); }
});

connections.post("/:service/sync", async (req, res, next) => {
  const service = req.params.service;
  if (!["plex", "trakt"].includes(service)) return res.status(400).json({ error: "Unknown service." });
  const conn = getConn(req.user.id, service);
  if (!conn) return res.status(404).json({ error: `Link ${service} first.` });
  try {
    const output = await withConnectionLock(`${req.user.id}:${service}:${eventConnectionId(conn)}`, async () => {
      let items;
      if (service === "trakt") {
        const refreshed = await traktHistoryWithRefresh(credentials(conn), conn.token_expires_at);
        items = refreshed.items;
        if (refreshed.credentials) db.prepare("UPDATE connections SET credentials_encrypted=?,token_expires_at=? WHERE user_id=? AND service='trakt'").run(encryptJson(refreshed.credentials, context(req.user.id, "trakt")), refreshed.expiresAt, req.user.id);
      } else {
        if (IS_HOSTED && !conn.server_machine_id) { const error = new Error("Hosted Plex connection has no verified machine identity."); error.status = 403; throw error; }
        const plexCredentials = credentials(conn);
        const legacyAccountId = !conn.provider_identity_id
          ? (Number(process.env.PLEX_HISTORY_ACCOUNT_ID || 0) || null)
          : null;
        const accountId = plexCredentials.isOwner
          ? 1
          : (plexCredentials.historyAccountId || legacyAccountId);
        items = await plexWatchedMovies(conn.server_url, plexCredentials.token, conn.server_machine_id || null, {
          accountId,
        });
        if (conn.provider_identity_id && !plexCredentials.isOwner && !plexCredentials.historyAccountId && items.length) {
          if (!items.accountId) throw new Error("Plex could not determine a unique local account for this shared user; re-link Plex.");
          const updated = { ...plexCredentials, historyAccountId: items.accountId };
          db.prepare("UPDATE connections SET credentials_encrypted=? WHERE user_id=? AND service='plex'")
            .run(encryptJson(updated, context(req.user.id, "plex")), req.user.id);
        }
      }
      const result = await importHistory(req.user.id, service, items, movieDetails, { connectionId: eventConnectionId(conn) });
      if (result.failed) {
        const error = new Error(`${service} history was incomplete; imported events remain idempotent, but sync was not marked complete.`);
        error.status = 502;
        throw error;
      }
      const newAchievements = [], seenKeys = new Set(), collectionIds = new Set(), personIds = new Set();
      const collect = (list) => { for (const achievement of list || []) if (!seenKeys.has(achievement.key)) { seenKeys.add(achievement.key); newAchievements.push(achievement); } };
      for (const tmdbId of result.movies) { try { const movie = await movieDetails(tmdbId); if (movie.belongs_to_collection?.id) collectionIds.add(movie.belongs_to_collection.id); for (const person of notablePeopleInMovie(movie.credits)) personIds.add(person.id); } catch {} }
      collect(await evaluate(req.user.id, {}));
      for (const collectionId of collectionIds) collect(await evaluate(req.user.id, { collection_id: collectionId }));
      for (const personId of personIds) { try { const achievement = await checkPersonCompletion(req.user.id, personId); if (achievement) collect([achievement]); } catch {} }
      db.prepare("UPDATE connections SET last_synced_at=datetime('now') WHERE user_id=? AND service=?").run(req.user.id, service);
      return { imported: result.imported, verified: result.verified, skipped: result.skipped, failed: result.failed, new_achievements: newAchievements };
    });
    res.json(output);
  } catch (error) { if (error.status === 401) return res.status(401).json({ error: `${service} rejected the stored credentials — re-link and try again.` }); next(error); }
});
connections.delete("/:service", (req, res) => {
  if (!["plex", "trakt"].includes(req.params.service)) return res.status(400).json({ error: "Unknown service." });
  db.transaction(() => {
    db.prepare("DELETE FROM connections WHERE user_id=? AND service=?").run(req.user.id, req.params.service);
    db.prepare("DELETE FROM provider_identities WHERE user_id=? AND provider=?").run(req.user.id, req.params.service);
  })();
  res.json({ ok: true });
});
