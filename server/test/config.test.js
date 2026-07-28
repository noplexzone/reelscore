// Pure validateConfig tests — no database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Self-hosted defaults
// ---------------------------------------------------------------------------

test("self_hosted: no secrets required in dev env", () => {
  const cfg = validateConfig({ APP_MODE: "self_hosted", NODE_ENV: "development" });
  assert.equal(cfg.IS_HOSTED, false);
  assert.equal(cfg.REGISTRATION_MODE, "open");
  assert.deepEqual(cfg.TRUSTED_PROXY_CIDRS, []);
});

test("self_hosted: SESSION_SECRET required in test env", () => {
  assert.throws(
    () => validateConfig({ APP_MODE: "self_hosted", NODE_ENV: "test" }),
    /SESSION_SECRET/
  );
});

test("self_hosted: short SESSION_SECRET rejected in test env", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "self_hosted",
        NODE_ENV: "test",
        SESSION_SECRET: "short",
      }),
    /SESSION_SECRET/
  );
});

test("self_hosted: strong SESSION_SECRET accepted in test env", () => {
  const cfg = validateConfig({
    APP_MODE: "self_hosted",
    NODE_ENV: "test",
    SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
  });
  assert.ok(cfg.SESSION_SECRET.length >= 32);
});

test("self_hosted: JWT_SECRET fallback accepted", () => {
  const cfg = validateConfig({
    APP_MODE: "self_hosted",
    NODE_ENV: "test",
    JWT_SECRET: "jwt-fallback-that-is-at-least-32-chars-long",
  });
  assert.ok(cfg.SESSION_SECRET.length >= 32);
});

test("self_hosted: REGISTRATION_MODE defaults to open", () => {
  const cfg = validateConfig({
    SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
    NODE_ENV: "test",
  });
  assert.equal(cfg.REGISTRATION_MODE, "open");
});

// ---------------------------------------------------------------------------
// Hosted mode validations — fail closed
// ---------------------------------------------------------------------------

const hosted = (overrides = {}) => ({
  APP_MODE: "hosted",
  SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
  CREDENTIAL_ENCRYPTION_KEY: "different-provider-key-that-is-at-least-32-chars",
  PLEX_ALLOWED_SERVER_ID: "allowed-machine",
  PLEX_ALLOWED_ORIGINS: "https://plex.example.com:32400",
  PLEX_CLIENT_IDENTIFIER: "reelscore-test",
  TRUSTED_PROXY_CIDRS: "172.29.0.2/32",
  PUBLIC_URL: "https://example.com",
  ...overrides,
});

test("hosted: missing SESSION_SECRET throws", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "hosted",
        PUBLIC_URL: "https://example.com",
      }),
    /SESSION_SECRET/
  );
});

test("hosted: short SESSION_SECRET throws", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "hosted",
        SESSION_SECRET: "short",
        PUBLIC_URL: "https://example.com",
      }),
    /SESSION_SECRET/
  );
});

test("hosted: missing PUBLIC_URL throws", () => {
  assert.throws(
    () => validateConfig(hosted({ PUBLIC_URL: undefined })),
    /PUBLIC_URL/
  );
});

test("hosted: invalid PUBLIC_URL throws", () => {
  assert.throws(
    () => validateConfig(hosted({ PUBLIC_URL: "not-a-url" })),
    /PUBLIC_URL/
  );
});

test("hosted: non-http PUBLIC_URL throws", () => {
  assert.throws(
    () => validateConfig(hosted({ PUBLIC_URL: "ftp://example.com" })),
    /PUBLIC_URL/
  );
});

test("hosted: malformed trusted proxy CIDR throws", () => {
  assert.throws(
    () => validateConfig(hosted({ TRUSTED_PROXY_CIDRS: "172.29.0.2/-1" })),
    /TRUSTED_PROXY_CIDRS/
  );
});

test("hosted: missing trusted proxy CIDR throws", () => {
  assert.throws(
    () => validateConfig(hosted({ TRUSTED_PROXY_CIDRS: undefined })),
    /TRUSTED_PROXY_CIDRS/
  );
});

test("hosted: exact Plex origin allowlist is required", () => {
  assert.throws(() => validateConfig(hosted({ PLEX_ALLOWED_ORIGINS: undefined })), /PLEX_ALLOWED_ORIGINS/);
});

test("hosted: short bootstrap token is rejected", () => {
  assert.throws(() => validateConfig(hosted({ BOOTSTRAP_ADMIN_TOKEN: "short" })), /BOOTSTRAP_ADMIN_TOKEN/);
});

test("hosted: missing Plex client identifier throws", () => {
  assert.throws(
    () => validateConfig(hosted({ PLEX_CLIENT_IDENTIFIER: undefined })),
    /PLEX_CLIENT_IDENTIFIER/
  );
});

test("hosted: credential key must differ from session secret", () => {
  const same = "same-secret-that-is-at-least-thirty-two-characters";
  assert.throws(
    () => validateConfig(hosted({ SESSION_SECRET: same, CREDENTIAL_ENCRYPTION_KEY: same })),
    /must be different/
  );
});

test("hosted: valid config succeeds", () => {
  const cfg = validateConfig(hosted({
    PUBLIC_URL: "https://app.example.com",
    REGISTRATION_MODE: "invite",
    TRUSTED_PROXY_CIDRS: "172.29.0.2/32",
  }));
  assert.equal(cfg.IS_HOSTED, true);
  assert.equal(cfg.REGISTRATION_MODE, "invite");
  assert.deepEqual(cfg.TRUSTED_PROXY_CIDRS, ["172.29.0.2/32"]);
  assert.equal(cfg.PUBLIC_URL, "https://app.example.com");
});

test("hosted: REGISTRATION_MODE defaults to invite", () => {
  const cfg = validateConfig(hosted());
  assert.equal(cfg.REGISTRATION_MODE, "invite");
});

test("hosted: REGISTRATION_MODE=closed is valid", () => {
  const cfg = validateConfig(hosted({ REGISTRATION_MODE: "closed" }));
  assert.equal(cfg.REGISTRATION_MODE, "closed");
});
