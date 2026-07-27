const env = process.env.NODE_ENV;
const raw = process.env.JWT_SECRET;

const DEV_FALLBACK = "dev-secret-fallback-please-change-me";

function resolveSecret() {
  if (env === "production") {
    if (!raw || raw.length < 32) {
      throw new Error(
        "[reelscore] FATAL: JWT_SECRET must be set and at least 32 characters in production."
      );
    }
    return raw;
  }

  if (env === "test") {
    if (!raw || raw.length < 32) {
      throw new Error(
        "[reelscore] TEST: JWT_SECRET must be set and at least 32 characters in test."
      );
    }
    return raw;
  }

  if (!raw || raw.length < 32) {
    console.warn(
      "[reelscore] WARNING: JWT_SECRET not set or too short — using insecure dev fallback. Never deploy this."
    );
    return DEV_FALLBACK;
  }
  return raw;
}

export const JWT_SECRET = resolveSecret();
