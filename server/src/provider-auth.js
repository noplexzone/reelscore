import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { createSession, setSessionCookie, sha256, randomHex, SESSION_COOKIE_NAME, sessionTokenHash } from "./auth.js";
import { IS_HOSTED, PUBLIC_URL, REGISTRATION_MODE, PLEX_ALLOWED_SERVER_ID, PLEX_ALLOWED_ORIGINS } from "./config.js";
import { decryptJson, encryptJson, plexHeaders, providerJson, validateDiscoveredPlexUri } from "./providers.js";

const PLEX_ORIGIN = new URL(process.env.PLEX_API_URL || "https://plex.tv").origin;
const PLEX_AUTH_URL = process.env.PLEX_AUTH_URL || "https://app.plex.tv/auth";
const TRAKT_API_ORIGIN = new URL(process.env.TRAKT_BASE_URL || "https://api.trakt.tv").origin;
const TRAKT_WEB_ORIGIN = new URL(process.env.TRAKT_WEB_URL || "https://trakt.tv").origin;
const FLOW_MS = 10 * 60 * 1000;
const BROWSER_COOKIE = IS_HOSTED ? "__Host-rs-provider" : "rs_provider";
const testLoopback = process.env.NODE_ENV === "test";
const providerPolicy = (origin, discoveredPlex = false) => {
  const independentlyAllowed = PLEX_ALLOWED_ORIGINS.includes(origin);
  return {
    allowedOrigins: IS_HOSTED && discoveredPlex ? PLEX_ALLOWED_ORIGINS : [origin],
    allowedPrivateOrigins: independentlyAllowed ? [origin] : [],
    allowTestLoopback: testLoopback,
  };
};
const flowContext = (flow, provider = flow.provider) => ({ userId: 0, connectionId: `flow:${flow.state_hash}`, provider, field: "flow_secret" });
export const providerAuthRouter = Router();
const providerStartLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many provider sign-in attempts." } });
const providerFlowLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 180, standardHeaders: true, legacyHeaders: false, message: { error: "Too many provider flow requests." } });

function browserHash(req, res, create = false) {
  let raw = req.cookies?.[BROWSER_COOKIE];
  if (!raw && create) {
    raw = randomHex(32);
    res.cookie(BROWSER_COOKIE, raw, { httpOnly: true, sameSite: "lax", secure: IS_HOSTED, path: "/", maxAge: FLOW_MS });
  }
  return raw ? sha256(raw) : null;
}
function currentSession(req) {
  const raw = req.cookies?.[SESSION_COOKIE_NAME];
  if (!raw) return null;
  return db.prepare(`SELECT s.token_hash,s.csrf_token,u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND datetime(s.expires_at) > datetime('now') AND COALESCE(s.last_seen_at,s.created_at) > datetime('now','-7 days') AND u.status='active'`).get(sessionTokenHash(raw));
}
function requireStartCsrf(req, current) {
  if (!current || req.headers["x-csrf-token"] !== current.csrf_token) { const error = new Error("Sign in with a valid CSRF token before linking."); error.status = current ? 403 : 401; throw error; }
}
function newFlow(req, res, provider, action, inviteCode) {
  const current = currentSession(req);
  if (action === "link") requireStartCsrf(req, current);
  const state = randomHex(32);
  db.prepare(`INSERT INTO provider_flows (state_hash,provider,action,session_hash,browser_hash,invite_hash,expires_at) VALUES (?,?,?,?,?,?,?)`).run(
    sha256(state), provider, action, current?.token_hash || null, browserHash(req, res, true), inviteCode ? sha256(String(inviteCode)) : null, new Date(Date.now() + FLOW_MS).toISOString());
  return { state };
}
function getFlow(req, state, provider) {
  const flow = db.prepare(`SELECT * FROM provider_flows WHERE state_hash=? AND provider=? AND consumed_at IS NULL AND datetime(expires_at) > datetime('now')`).get(sha256(String(state || "")), provider);
  if (!flow || !browserHash(req, null, false) || flow.browser_hash !== browserHash(req, null, false)) { const error = new Error("Provider flow is invalid or expired."); error.status = 400; throw error; }
  if (flow.action === "link") {
    const current = currentSession(req);
    if (!current || current.token_hash !== flow.session_hash) { const error = new Error("Provider link is not bound to this session."); error.status = 403; throw error; }
  }
  return flow;
}
function uniqueUsername(preferred) {
  const base = String(preferred || "movie_fan").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20) || "movie_fan";
  let value = base.length >= 3 ? base : `user_${base}`;
  for (let n = 1; db.prepare("SELECT 1 FROM users WHERE username=?").get(value); n++) value = `${base.slice(0, 15)}_${n}`;
  return value;
}
function connectionContext(userId, provider) { return { userId, connectionId: `${userId}:${provider}`, provider, field: "credentials" }; }

export async function finishFlow(flow, provider, identity, credentials, connection, req, res, admission = {}) {
  if (!identity?.id) { const error = new Error(`${provider} did not return an immutable identity.`); error.status = 502; throw error; }
  const passwordHash = await bcrypt.hash(randomHex(32), 10);
  let sessionResult = null;
  const result = db.transaction(() => {
    const liveFlow = db.prepare("SELECT * FROM provider_flows WHERE state_hash=? AND consumed_at IS NULL AND datetime(expires_at) > datetime('now')").get(flow.state_hash);
    if (!liveFlow || liveFlow.provider !== provider || liveFlow.action !== flow.action) { const error = new Error("Provider flow was already consumed."); error.status = 409; throw error; }
    const signedIn = flow.action === "link" ? currentSession(req) : null;
    if (flow.action === "link" && (!signedIn || signedIn.token_hash !== liveFlow.session_hash)) { const error = new Error("Provider link is not bound to this session."); error.status = 403; throw error; }
    let providerIdentity = db.prepare("SELECT * FROM provider_identities WHERE provider=? AND provider_user_id=?").get(provider, String(identity.id));
    let userId = signedIn?.id || providerIdentity?.user_id || null;
    if (signedIn && providerIdentity && providerIdentity.user_id !== signedIn.id) { const error = new Error("That provider account is already linked."); error.status = 409; throw error; }
    let invite = null;
    if (!userId) {
      if (IS_HOSTED && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c === 0) {
        const error = new Error("Administrator onboarding must be completed before provider registration.");
        error.status = 503;
        throw error;
      }
      if (liveFlow.invite_hash) invite = db.prepare(`SELECT * FROM invites WHERE token_hash=? AND revoked=0 AND used_by IS NULL AND datetime(expires_at) > datetime('now')`).get(liveFlow.invite_hash);
      const plexAdmission = provider === "plex" && REGISTRATION_MODE === "plex_server" && admission.allowedServer === true;
      const registrationAllowed = REGISTRATION_MODE === "open" || plexAdmission || !!invite;
      if (REGISTRATION_MODE === "closed" || !registrationAllowed) { const error = new Error("A valid invitation is required for this provider sign-in."); error.status = 403; throw error; }
      userId = Number(db.prepare("INSERT INTO users (username,password_hash) VALUES (?,?)").run(uniqueUsername(identity.name), passwordHash).lastInsertRowid);
      if (invite) {
        const consumed = db.prepare("UPDATE invites SET used_by=?,used_at=datetime('now') WHERE id=? AND used_by IS NULL AND revoked=0").run(userId, invite.id);
        if (consumed.changes !== 1) { const error = new Error("Invitation was already used."); error.status = 409; throw error; }
      }
    }
    if (!providerIdentity) {
      const id = Number(db.prepare("INSERT INTO provider_identities (provider,provider_user_id,user_id,display_name) VALUES (?,?,?,?)").run(provider, String(identity.id), userId, identity.name || null).lastInsertRowid);
      providerIdentity = { id, user_id: userId };
    }
    const encrypted = encryptJson(credentials, connectionContext(userId, provider));
    db.prepare(`INSERT INTO connections (user_id,service,access_token,refresh_token,server_url,service_username,credentials_encrypted,provider_identity_id,server_machine_id,token_expires_at)
      VALUES (?,?,NULL,NULL,?,?,?,?,?,?) ON CONFLICT(user_id,service) DO UPDATE SET access_token=NULL,refresh_token=NULL,server_url=excluded.server_url,service_username=excluded.service_username,credentials_encrypted=excluded.credentials_encrypted,provider_identity_id=excluded.provider_identity_id,server_machine_id=excluded.server_machine_id,token_expires_at=excluded.token_expires_at,connected_at=datetime('now')`).run(
      userId, provider, connection.serverUrl || null, connection.displayName || identity.name || null, encrypted, providerIdentity.id, connection.machineId || null, connection.expiresAt || null);
    const consumed = db.prepare("UPDATE provider_flows SET consumed_at=datetime('now'),secret_encrypted=NULL WHERE state_hash=? AND consumed_at IS NULL").run(flow.state_hash);
    if (consumed.changes !== 1) { const error = new Error("Provider flow was already consumed."); error.status = 409; throw error; }
    if (flow.action === "login") sessionResult = createSession(userId, { ip: req.ip, userAgent: req.headers["user-agent"] || null });
    return { linked: true, userId };
  })();
  if (sessionResult) {
    setSessionCookie(res, sessionResult.token);
    return { linked: true, csrf_token: sessionResult.csrfToken, user: db.prepare("SELECT id,username,role FROM users WHERE id=?").get(result.userId) };
  }
  return { linked: true };
}

async function verifyPlex(origin, token, expectedMachineId) {
  if (!validateDiscoveredPlexUri(origin)) throw new Error("Plex resource URL is invalid.");
  const identity = await providerJson(`${origin}/identity`, { headers: plexHeaders(token) }, providerPolicy(origin, true));
  const container = identity?.MediaContainer || identity || {};
  const machineId = String(container.machineIdentifier || container.machine_identifier || "");
  if (!machineId || machineId !== expectedMachineId || (PLEX_ALLOWED_SERVER_ID && machineId !== PLEX_ALLOWED_SERVER_ID)) { const error = new Error("Plex server identity does not match the allowed machine."); error.status = 403; throw error; }
  return container.friendlyName || "Plex Media Server";
}

providerAuthRouter.post("/plex/start", providerStartLimiter, async (req, res, next) => {
  try {
    const action = req.body?.action === "link" ? "link" : "login";
    const { state } = newFlow(req, res, "plex", action, req.body?.invite_code);
    const pin = await providerJson(`${PLEX_ORIGIN}/api/v2/pins?strong=true`, { method: "POST", headers: plexHeaders() }, providerPolicy(PLEX_ORIGIN));
    db.prepare("UPDATE provider_flows SET remote_id=? WHERE state_hash=?").run(String(pin.id), sha256(state));
    const forward = `${PUBLIC_URL || "http://localhost"}/login?plex_state=${state}`;
    const authQuery = new URLSearchParams({
      clientID: process.env.PLEX_CLIENT_IDENTIFIER || process.env.PLEX_CLIENT_ID || "reelscore-self-hosted",
      code: String(pin.code),
      forwardUrl: forward,
      "context[device][product]": "ReelScore",
    });
    res.set("Cache-Control", "no-store").json({ state, expires_in: Math.min(Number(pin.expiresIn || 600), 600), auth_url: `${PLEX_AUTH_URL}#?${authQuery}` });
  } catch (error) { next(error); }
});
providerAuthRouter.get("/plex/poll", providerFlowLimiter, async (req, res, next) => {
  try {
    const flow = getFlow(req, req.query.state, "plex");
    const pin = await providerJson(`${PLEX_ORIGIN}/api/v2/pins/${encodeURIComponent(flow.remote_id)}`, { headers: plexHeaders() }, providerPolicy(PLEX_ORIGIN));
    if (!pin.authToken) return res.status(202).set("Cache-Control", "no-store").json({ pending: true });
    const [user, resourceData] = await Promise.all([
      providerJson(`${PLEX_ORIGIN}/api/v2/user`, { headers: plexHeaders(pin.authToken) }, providerPolicy(PLEX_ORIGIN)),
      providerJson(`${PLEX_ORIGIN}/api/v2/resources?includeHttps=1&includeRelay=1`, { headers: plexHeaders(pin.authToken) }, providerPolicy(PLEX_ORIGIN)),
    ]);
    const resources = (Array.isArray(resourceData) ? resourceData : resourceData?.MediaContainer?.Device || []).filter((resource) => String(resource.provides || "").split(",").includes("server"));
    const servers = [];
    for (const resource of resources) {
      const machineId = String(resource.clientIdentifier || resource.machineIdentifier || "");
      if (PLEX_ALLOWED_SERVER_ID && machineId !== PLEX_ALLOWED_SERVER_ID) continue;
      const token = resource.accessToken || resource.access_token || pin.authToken;
      for (const candidate of resource.connections || resource.Connection || []) {
        const origin = validateDiscoveredPlexUri(candidate.uri);
        if (origin && token && (!IS_HOSTED || PLEX_ALLOWED_ORIGINS.includes(origin))) servers.push({
          selectionId: randomHex(16),
          machineId,
          name: resource.name || "Plex Media Server",
          origin,
          token,
          isOwner: resource.owned === true || Number(resource.owned) === 1,
        });
      }
    }
    const secret = { accountToken: pin.authToken, user: { id: String(user.id), name: user.username || user.title }, servers };
    db.prepare("UPDATE provider_flows SET secret_encrypted=? WHERE state_hash=? AND consumed_at IS NULL").run(encryptJson(secret, flowContext(flow)), flow.state_hash);
    res.set("Cache-Control", "no-store").json({ pending: false, servers: servers.map((server) => ({ selection_id: server.selectionId, machine_id: server.machineId, name: server.name })) });
  } catch (error) { next(error); }
});
providerAuthRouter.post("/plex/complete", providerFlowLimiter, async (req, res, next) => {
  try {
    const flow = getFlow(req, req.body?.state, "plex");
    if (!flow.secret_encrypted) return res.status(409).json({ error: "Finish Plex authorization first." });
    const secret = decryptJson(flow.secret_encrypted, flowContext(flow));
    const selected = secret.servers.find((server) => server.selectionId === req.body?.selection_id);
    if (!selected || !selected.machineId || (PLEX_ALLOWED_SERVER_ID && selected.machineId !== PLEX_ALLOWED_SERVER_ID)) return res.status(403).json({ error: "That Plex server is not allowed." });
    const displayName = await verifyPlex(selected.origin, selected.token, selected.machineId);
    res.set("Cache-Control", "no-store").json(await finishFlow(flow, "plex", secret.user, {
      token: selected.token,
      isOwner: selected.isOwner,
    }, { serverUrl: selected.origin, machineId: selected.machineId, displayName }, req, res, { allowedServer: true }));
  } catch (error) { next(error); }
});

const traktRedirectUri = () => `${PUBLIC_URL || "http://localhost"}/api/auth/provider/trakt/callback`;
providerAuthRouter.post("/trakt/start", providerStartLimiter, (req, res, next) => {
  try {
    if (!process.env.TRAKT_CLIENT_ID || !process.env.TRAKT_CLIENT_SECRET) return res.status(503).json({ error: "Trakt is not configured." });
    const { state } = newFlow(req, res, "trakt", req.body?.action === "link" ? "link" : "login", req.body?.invite_code);
    const authUrl = new URL("/oauth/authorize", TRAKT_WEB_ORIGIN);
    authUrl.search = new URLSearchParams({ response_type: "code", client_id: process.env.TRAKT_CLIENT_ID, redirect_uri: traktRedirectUri(), state }).toString();
    res.set("Cache-Control", "no-store").json({ state, auth_url: authUrl.toString() });
  } catch (error) { next(error); }
});
async function completeTrakt(req, res) {
  const state = req.method === "GET" ? req.query.state : req.body?.state;
  const code = req.method === "GET" ? req.query.code : req.body?.code;
  const flow = getFlow(req, state, "trakt");
  if (!code || String(code).length > 512) { const error = new Error("Trakt authorization code is missing."); error.status = 400; throw error; }
  const token = await providerJson(`${TRAKT_API_ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, client_id: process.env.TRAKT_CLIENT_ID, client_secret: process.env.TRAKT_CLIENT_SECRET, redirect_uri: traktRedirectUri(), grant_type: "authorization_code" }) }, providerPolicy(TRAKT_API_ORIGIN));
  const profile = await providerJson(`${TRAKT_API_ORIGIN}/users/settings`, { headers: { Authorization: `Bearer ${token.access_token}`, "trakt-api-version": "2", "trakt-api-key": process.env.TRAKT_CLIENT_ID } }, providerPolicy(TRAKT_API_ORIGIN));
  const immutableId = profile?.user?.ids?.trakt;
  if (immutableId == null) throw new Error("Trakt did not return an immutable identity.");
  const expiresAt = token.expires_in ? new Date((Number(token.created_at || Math.floor(Date.now() / 1000)) + Number(token.expires_in)) * 1000).toISOString() : null;
  return finishFlow(flow, "trakt", { id: String(immutableId), name: profile?.user?.username }, { accessToken: token.access_token, refreshToken: token.refresh_token || null }, { expiresAt }, req, res);
}
providerAuthRouter.get("/trakt/callback", providerFlowLimiter, async (req, res, next) => { try { await completeTrakt(req, res); res.redirect(303, "/"); } catch (error) { next(error); } });
providerAuthRouter.post("/trakt/complete", providerFlowLimiter, async (req, res, next) => { try { res.set("Cache-Control", "no-store").json(await completeTrakt(req, res)); } catch (error) { next(error); } });
