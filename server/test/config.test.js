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
  assert.equal(cfg.TRUST_PROXY, 0);
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
    () =>
      validateConfig({
        APP_MODE: "hosted",
        SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
      }),
    /PUBLIC_URL/
  );
});

test("hosted: invalid PUBLIC_URL throws", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "hosted",
        SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
        PUBLIC_URL: "not-a-url",
      }),
    /PUBLIC_URL/
  );
});

test("hosted: non-http PUBLIC_URL throws", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "hosted",
        SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
        PUBLIC_URL: "ftp://example.com",
      }),
    /PUBLIC_URL/
  );
});

test("hosted: negative TRUST_PROXY throws", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "hosted",
        SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
        PUBLIC_URL: "https://example.com",
        TRUST_PROXY: "-1",
      }),
    /TRUST_PROXY/
  );
});

test("hosted: non-numeric TRUST_PROXY throws", () => {
  assert.throws(
    () =>
      validateConfig({
        APP_MODE: "hosted",
        SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
        PUBLIC_URL: "https://example.com",
        TRUST_PROXY: "cloudflare",
      }),
    /TRUST_PROXY/
  );
});

test("hosted: valid config succeeds", () => {
  const cfg = validateConfig({
    APP_MODE: "hosted",
    SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
    PUBLIC_URL: "https://app.example.com",
    REGISTRATION_MODE: "invite",
    TRUST_PROXY: "1",
  });
  assert.equal(cfg.IS_HOSTED, true);
  assert.equal(cfg.REGISTRATION_MODE, "invite");
  assert.equal(cfg.TRUST_PROXY, 1);
  assert.equal(cfg.PUBLIC_URL, "https://app.example.com");
});

test("hosted: REGISTRATION_MODE defaults to invite", () => {
  const cfg = validateConfig({
    APP_MODE: "hosted",
    SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
    PUBLIC_URL: "https://example.com",
  });
  assert.equal(cfg.REGISTRATION_MODE, "invite");
});

test("hosted: REGISTRATION_MODE=closed is valid", () => {
  const cfg = validateConfig({
    APP_MODE: "hosted",
    SESSION_SECRET: "test-secret-that-is-at-least-32-chars-long",
    PUBLIC_URL: "https://example.com",
    REGISTRATION_MODE: "closed",
  });
  assert.equal(cfg.REGISTRATION_MODE, "closed");
});
