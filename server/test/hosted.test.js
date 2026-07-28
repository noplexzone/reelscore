process.env.DATA_DIR = `/tmp/rs-hosted-${process.pid}`;
process.env.SESSION_SECRET = "hosted-session-secret-that-is-at-least-32-characters";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "hosted";
process.env.PUBLIC_URL = "https://hosted.example.test";
process.env.CREDENTIAL_ENCRYPTION_KEY = "independent-credential-key-at-least-32-characters";
process.env.PLEX_ALLOWED_SERVER_ID = "allowed-machine";
process.env.PLEX_ALLOWED_ORIGINS = "https://plex.example.test:32400";
process.env.PLEX_CLIENT_IDENTIFIER = "reelscore-hosted-test";
process.env.TRUSTED_PROXY_CIDRS = "172.29.0.2/32";
process.env.BOOTSTRAP_ADMIN_TOKEN = "bootstrap-token-that-is-at-least-32-characters";

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

let server, base, db, app;
const publicHeaders = { Host: "hosted.example.test", Origin: "https://hosted.example.test" };

function rawRequest(pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port: server.address().port, path: pathname, method,
      headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

before(async () => {
  ({ createApp: app } = await import("../src/index.js"));
  ({ db } = await import("../src/db.js"));
  const expressApp = app();
  const trust = expressApp.get("trust proxy fn");
  assert.equal(trust("127.0.0.1"), false);
  assert.equal(trust("172.29.0.2"), true);
  server = createServer(expressApp);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test("internal health is loopback-only and bypasses public Host validation", async () => {
  const internal = await fetch(`${base}/api/internal/health`);
  assert.equal(internal.status, 200);
  assert.deepEqual(await internal.json(), { ok: true });
  const publicHealth = await fetch(`${base}/api/health`);
  assert.equal(publicHealth.status, 400);
});

test("hosted mutations require the exact serialized Origin", async () => {
  const missing = await rawRequest("/api/auth/bootstrap", {
    method: "POST", headers: { Host: "hosted.example.test", "content-type": "application/json", "x-bootstrap-token": process.env.BOOTSTRAP_ADMIN_TOKEN }, body: "{}",
  });
  assert.equal(missing.status, 403);
  const normalizedButNotExact = await rawRequest("/api/auth/bootstrap", {
    method: "POST", headers: { Host: "hosted.example.test", Origin: "https://hosted.example.test/", "content-type": "application/json", "x-bootstrap-token": process.env.BOOTSTRAP_ADMIN_TOKEN }, body: "{}",
  });
  assert.equal(normalizedButNotExact.status, 403);
});

test("first admin bootstrap is one-use and issues a secure __Host cookie", async () => {
  const response = await rawRequest("/api/auth/bootstrap", {
    method: "POST",
    headers: { ...publicHeaders, "content-type": "application/json", "x-bootstrap-token": process.env.BOOTSTRAP_ADMIN_TOKEN, "x-forwarded-for": "198.51.100.99" },
    body: JSON.stringify({ username: "hostadmin", password: "long-unique-bootstrap-password" }),
  });
  const body = JSON.parse(response.text);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.user.role, "admin");
  assert.equal(response.headers["cache-control"], "no-store");
  const cookie = String(response.headers["set-cookie"] || "");
  assert.match(cookie, /^__Host-reelscore-session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c, 1);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='bootstrap_admin_consumed'").get().value, "1");
  assert.match(db.prepare("SELECT ip FROM sessions ORDER BY created_at DESC LIMIT 1").get().ip, /127\.0\.0\.1/);

  const replay = await rawRequest("/api/auth/bootstrap", {
    method: "POST",
    headers: { ...publicHeaders, "content-type": "application/json", "x-bootstrap-token": process.env.BOOTSTRAP_ADMIN_TOKEN },
    body: JSON.stringify({ username: "anotheradmin", password: "another-long-unique-password" }),
  });
  assert.equal(replay.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users").get().c, 1);
});

test("invalid hosted configuration leaves an existing database byte-identical", () => {
  const dir = `/tmp/rs-invalid-config-${process.pid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "reelscore.db");
  const fixture = new Database(dbPath);
  fixture.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('unchanged')");
  fixture.close();
  const before = createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import('./src/index.js').then(m=>m.createApp())"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      DATA_DIR: dir,
      PUBLIC_URL: "not-a-url",
    },
    encoding: "utf8",
  });
  assert.notEqual(child.status, 0);
  const afterHash = createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex");
  assert.equal(afterHash, before);
  assert.equal(fs.existsSync(path.join(dir, "backups")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fresh hosted startup without a bootstrap token creates no database", () => {
  const dir = `/tmp/rs-no-bootstrap-${process.pid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const env = { ...process.env, DATA_DIR: dir };
  delete env.BOOTSTRAP_ADMIN_TOKEN;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import('./src/index.js').then(m=>m.createApp())"], {
    cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8",
  });
  assert.notEqual(child.status, 0);
  assert.equal(fs.existsSync(path.join(dir, "reelscore.db")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
