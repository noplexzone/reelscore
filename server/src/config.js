import { URL } from "url";
import { isIP } from "node:net";

function originList(raw) {
  return String(raw || "").split(",").map((v) => v.trim()).filter(Boolean).map((value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("[reelscore] PLEX_ALLOWED_ORIGINS entries must be HTTP(S) origins.");
    return url.origin;
  });
}

function cidrList(raw) {
  return String(raw || "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
    const [address, prefixRaw] = value.split("/");
    const family = isIP(address);
    const prefix = Number(prefixRaw);
    const max = family === 4 ? 32 : 128;
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error("[reelscore] TRUSTED_PROXY_CIDRS must contain explicit IPv4/IPv6 CIDRs.");
    }
    return `${address}/${prefix}`;
  });
}

export function validateConfig(env = {}) {
  const mode = env.APP_MODE || "self_hosted";
  const isHosted = mode === "hosted";
  const sessionSecret = env.SESSION_SECRET || env.JWT_SECRET || null;
  const credentialKey = env.CREDENTIAL_ENCRYPTION_KEY || null;
  const credentialKeyId = env.CREDENTIAL_ENCRYPTION_KEY_ID || "active";
  const publicUrl = env.PUBLIC_URL || null;
  const plexClientIdentifier = env.PLEX_CLIENT_IDENTIFIER || env.PLEX_CLIENT_ID || null;
  const registrationMode = env.REGISTRATION_MODE || (isHosted ? "invite" : "open");
  const trustedProxyCidrs = cidrList(env.TRUSTED_PROXY_CIDRS);
  const bootstrapAdminToken = env.BOOTSTRAP_ADMIN_TOKEN || null;
  const nodeEnv = env.NODE_ENV || null;
  if (!["self_hosted", "hosted"].includes(mode)) throw new Error("[reelscore] APP_MODE must be self_hosted or hosted.");
  if ((nodeEnv === "test" || nodeEnv === "production") && (!sessionSecret || sessionSecret.length < 32)) throw new Error("[reelscore] SESSION_SECRET must be set and at least 32 characters.");

  let parsedPublic = null;
  if (publicUrl) {
    try { parsedPublic = new URL(publicUrl); } catch { throw new Error("[reelscore] FATAL: PUBLIC_URL must be a valid URL."); }
  }
  if (isHosted) {
    if (!sessionSecret || sessionSecret.length < 32) throw new Error("[reelscore] FATAL: SESSION_SECRET must be set and at least 32 chars in hosted mode.");
    if (!credentialKey || credentialKey.length < 32) throw new Error("[reelscore] FATAL: CREDENTIAL_ENCRYPTION_KEY must be set independently and be at least 32 chars in hosted mode.");
    if (credentialKey === sessionSecret) throw new Error("[reelscore] FATAL: credential and session secrets must be different in hosted mode.");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(credentialKeyId)) throw new Error("[reelscore] FATAL: CREDENTIAL_ENCRYPTION_KEY_ID is invalid.");
    if (!parsedPublic) throw new Error("[reelscore] FATAL: PUBLIC_URL must be set in hosted mode.");
    if (parsedPublic.protocol !== "https:" || parsedPublic.username || parsedPublic.password || parsedPublic.pathname !== "/" || parsedPublic.search || parsedPublic.hash) throw new Error("[reelscore] FATAL: PUBLIC_URL must be an HTTPS origin without credentials, path, query, or fragment.");
    if (!["invite", "closed", "plex_server"].includes(registrationMode)) throw new Error("[reelscore] FATAL: hosted REGISTRATION_MODE must be invite, plex_server, or closed.");
    if (!String(env.PLEX_ALLOWED_SERVER_ID || "").trim()) throw new Error("[reelscore] FATAL: PLEX_ALLOWED_SERVER_ID is required in hosted mode.");
    if (!plexClientIdentifier) throw new Error("[reelscore] FATAL: PLEX_CLIENT_IDENTIFIER is required in hosted mode.");
    if (!trustedProxyCidrs.length) throw new Error("[reelscore] FATAL: TRUSTED_PROXY_CIDRS is required in hosted mode.");
    if (!originList(env.PLEX_ALLOWED_ORIGINS).length) throw new Error("[reelscore] FATAL: PLEX_ALLOWED_ORIGINS must independently allow exact credential-bearing Plex origins in hosted mode.");
    if (bootstrapAdminToken && bootstrapAdminToken.length < 32) throw new Error("[reelscore] FATAL: BOOTSTRAP_ADMIN_TOKEN must be at least 32 characters.");
  }
  let previousKeys = {};
  try { previousKeys = JSON.parse(env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS || "{}"); } catch { throw new Error("[reelscore] CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object."); }
  if (!previousKeys || Array.isArray(previousKeys) || typeof previousKeys !== "object" || Object.values(previousKeys).some((v) => typeof v !== "string" || v.length < 32)) throw new Error("[reelscore] CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must map key IDs to strong secrets.");
  const plexAllowedOrigins = originList(env.PLEX_ALLOWED_ORIGINS);
  if (!!env.TRAKT_CLIENT_ID !== !!env.TRAKT_CLIENT_SECRET) throw new Error("[reelscore] TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET must be configured together.");
  let resolvedSecret = sessionSecret;
  if (!isHosted && nodeEnv !== "test" && nodeEnv !== "production" && !resolvedSecret) {
    resolvedSecret = "dev-secret-fallback-please-change-me-32x";
    console.warn("[reelscore] WARNING: SESSION_SECRET not set — using insecure dev fallback.");
  }
  return {
    APP_MODE: mode, IS_HOSTED: isHosted, SESSION_SECRET: resolvedSecret,
    CREDENTIAL_ENCRYPTION_KEY: credentialKey || (isHosted ? null : "reelscore-local-provider-key-change-me"),
    CREDENTIAL_ENCRYPTION_KEY_ID: credentialKeyId, CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: previousKeys,
    PUBLIC_URL: publicUrl, REGISTRATION_MODE: registrationMode,
    TRUSTED_PROXY_CIDRS: trustedProxyCidrs, BOOTSTRAP_ADMIN_TOKEN: bootstrapAdminToken,
    PLEX_ALLOWED_SERVER_ID: String(env.PLEX_ALLOWED_SERVER_ID || "").trim(), PLEX_ALLOWED_ORIGINS: plexAllowedOrigins,
    PLEX_CLIENT_IDENTIFIER: plexClientIdentifier,
  };
}

const _cfg = validateConfig(process.env);
export const APP_MODE = _cfg.APP_MODE;
export const IS_HOSTED = _cfg.IS_HOSTED;
export const SESSION_SECRET = _cfg.SESSION_SECRET;
export const CREDENTIAL_ENCRYPTION_KEY = _cfg.CREDENTIAL_ENCRYPTION_KEY;
export const CREDENTIAL_ENCRYPTION_KEY_ID = _cfg.CREDENTIAL_ENCRYPTION_KEY_ID;
export const PUBLIC_URL = _cfg.PUBLIC_URL;
export const REGISTRATION_MODE = _cfg.REGISTRATION_MODE;
export const TRUSTED_PROXY_CIDRS = _cfg.TRUSTED_PROXY_CIDRS;
export const BOOTSTRAP_ADMIN_TOKEN = _cfg.BOOTSTRAP_ADMIN_TOKEN;
export const PLEX_ALLOWED_SERVER_ID = _cfg.PLEX_ALLOWED_SERVER_ID;
export const PLEX_ALLOWED_ORIGINS = _cfg.PLEX_ALLOWED_ORIGINS;
export const PLEX_CLIENT_IDENTIFIER = _cfg.PLEX_CLIENT_IDENTIFIER;
export const JWT_SECRET = SESSION_SECRET;
