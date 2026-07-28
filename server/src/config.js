import { URL } from "url";

// ---------------------------------------------------------------------------
// Pure config validator — accepts an env object for testability.
// ---------------------------------------------------------------------------

export function validateConfig(env = {}) {
  const mode = env.APP_MODE || "self_hosted";
  const isHosted = mode === "hosted";
  const sessionSecret = env.SESSION_SECRET || env.JWT_SECRET || null;
  const publicUrl = env.PUBLIC_URL || null;
  const rawReg = env.REGISTRATION_MODE || null;
  const rawProxy = env.TRUST_PROXY;
  const nodeEnv = env.NODE_ENV || null;

  if (!["self_hosted", "hosted"].includes(mode)) {
    throw new Error("[reelscore] APP_MODE must be self_hosted or hosted.");
  }

  const registrationMode = rawReg || (isHosted ? "invite" : "open");

  // In test/production, always require a strong secret (any mode).
  if (nodeEnv === "test" || nodeEnv === "production") {
    if (!sessionSecret || sessionSecret.length < 32) {
      throw new Error(
        "[reelscore] SESSION_SECRET must be set and at least 32 characters."
      );
    }
  }

  if (isHosted) {
    if (!sessionSecret || sessionSecret.length < 32) {
      throw new Error(
        "[reelscore] FATAL: SESSION_SECRET must be set and at least 32 chars in hosted mode."
      );
    }
    if (!publicUrl) {
      throw new Error("[reelscore] FATAL: PUBLIC_URL must be set in hosted mode.");
    }
    let parsed;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new Error("[reelscore] FATAL: PUBLIC_URL must be a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("[reelscore] FATAL: PUBLIC_URL must use https in hosted mode.");
    }
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("[reelscore] FATAL: PUBLIC_URL must be an origin without credentials, path, query, or fragment.");
    }

    if (!["invite", "closed"].includes(registrationMode)) {
      throw new Error(
        "[reelscore] FATAL: hosted REGISTRATION_MODE must be invite or closed."
      );
    }

    if (
      rawProxy !== undefined &&
      rawProxy !== null &&
      rawProxy !== "" &&
      (!Number.isInteger(Number(rawProxy)) || Number(rawProxy) < 0)
    ) {
      throw new Error(
        "[reelscore] FATAL: TRUST_PROXY must be a non-negative integer."
      );
    }
  }

  const trustProxy =
    rawProxy !== undefined && rawProxy !== null && rawProxy !== ""
      ? Number(rawProxy)
      : 0;

  let resolvedSecret = sessionSecret;
  if (!isHosted && nodeEnv !== "test" && nodeEnv !== "production") {
    resolvedSecret =
      sessionSecret ||
      "dev-secret-fallback-please-change-me-32x";
    if (!sessionSecret) {
      console.warn(
        "[reelscore] WARNING: SESSION_SECRET not set — using insecure dev fallback."
      );
    }
  }

  return {
    APP_MODE: mode,
    IS_HOSTED: isHosted,
    SESSION_SECRET: resolvedSecret,
    PUBLIC_URL: publicUrl,
    REGISTRATION_MODE: registrationMode,
    TRUST_PROXY: trustProxy,
  };
}

// ---------------------------------------------------------------------------
// Module-level config, resolved from process.env at startup.
// ---------------------------------------------------------------------------

const _cfg = validateConfig(process.env);

export const APP_MODE = _cfg.APP_MODE;
export const IS_HOSTED = _cfg.IS_HOSTED;
export const SESSION_SECRET = _cfg.SESSION_SECRET;
export const PUBLIC_URL = _cfg.PUBLIC_URL;
export const REGISTRATION_MODE = _cfg.REGISTRATION_MODE;
export const TRUST_PROXY = _cfg.TRUST_PROXY;

// Keep legacy alias.
export const JWT_SECRET = SESSION_SECRET;
