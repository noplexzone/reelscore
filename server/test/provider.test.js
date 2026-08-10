process.env.DATA_DIR = `/tmp/rs-provider-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

let stubServer, origin, providers, db, createApp, startTestServer, parseCookies, sync;
let traktHistoryPayload = [];
let traktPageCount = null;
let plexTotalSize = null;
let plexHistoryPayload = [
  { historyKey: "/status/sessions/history/9001", ratingKey: "501", viewedAt: 1577836800, accountID: 42, Guid: [{ id: "tmdb://501" }] },
  { historyKey: "/status/sessions/history/9002", ratingKey: "502", viewedAt: 1577836860, accountID: 42 },
];
const requests = [];
function json(res, status, value, headers = {}) { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body); }

before(async () => {
  stubServer = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, plex: req.headers["x-plex-token"] });
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); return res.end(); }
    if (req.url === "/slow") return;
    if (req.url === "/large") return res.end("x".repeat(256));
    if (req.method === "POST" && req.url.startsWith("/api/v2/pins")) return json(res, 200, { id: 7, code: "ABCD", expiresIn: 600 });
    if (req.url === "/api/v2/pins/7") return json(res, 200, { authToken: "PLEX_ACCOUNT_SECRET" });
    if (req.url === "/api/v2/user") return json(res, 200, { id: 991, username: "same_name" });
    if (req.url.startsWith("/api/v2/resources")) return json(res, 200, [{ provides: "server", owned: true, clientIdentifier: "allowed-machine", name: "Allowed Plex", accessToken: "PLEX_SERVER_SECRET", connections: [{ uri: `${origin}/web` }, { uri: "http://169.254.169.254/latest/meta-data" }] }]);
    if (req.url === "/identity") return json(res, 200, { MediaContainer: { machineIdentifier: "allowed-machine", friendlyName: "Verified Plex" } });
    if (req.url === "/oauth/token") return json(res, 200, { access_token: "NEW_TRAKT_SECRET", refresh_token: "NEW_REFRESH", created_at: Math.floor(Date.now() / 1000), expires_in: 3600 });
    if (req.url.startsWith("/sync/history/movies")) return req.headers.authorization === "Bearer OLD_TRAKT_SECRET"
      ? json(res, 401, {})
      : json(res, 200, traktHistoryPayload, traktPageCount ? { "x-pagination-page-count": String(traktPageCount) } : {});
    if (req.url.startsWith("/status/sessions/history/all")) return json(res, 200, {
      MediaContainer: { Metadata: plexHistoryPayload, ...(plexTotalSize == null ? {} : { totalSize: plexTotalSize }) },
    });
    if (req.url === "/library/metadata/502?includeGuids=1") return json(res, 200, { MediaContainer: { Metadata: [{ ratingKey: "502", Guid: [{ id: "com.plexapp.agents.themoviedb://502?lang=en" }] }] } });
    if (req.url === "/users/settings") return json(res, 200, { user: { username: "same_name", ids: { trakt: 444, slug: "mutable-slug" } } });
    json(res, 404, {});
  });
  await new Promise((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${stubServer.address().port}`;
  process.env.PLEX_API_URL = origin;
  process.env.TRAKT_BASE_URL = origin;
  process.env.TRAKT_WEB_URL = origin;
  process.env.TRAKT_CLIENT_ID = "trakt-client";
  process.env.TRAKT_CLIENT_SECRET = "trakt-client-secret";
  process.env.PLEX_ALLOWED_SERVER_ID = "allowed-machine";
  process.env.PLEX_ALLOWED_ORIGINS = origin;
  process.env.PLEX_CLIENT_IDENTIFIER = "reelscore-test";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "provider-encryption-secret-at-least-32-characters";
  process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "key-2026";
  process.env.PUBLIC_URL = "http://public.example";
  providers = await import("../src/providers.js");
  ({ db } = await import("../src/db.js"));
  ({ createApp } = await import("../src/index.js"));
  ({ startTestServer, parseCookies } = await import("./helpers/server.js"));
  sync = await import("../src/sync.js");
});
after(async () => { await new Promise((resolve) => stubServer.close(resolve)); });

const ctx = (userId = 1, provider = "plex") => ({ userId, connectionId: `${userId}:${provider}`, provider, field: "credentials" });

test("AEAD envelopes are randomized, key identified, tamper evident, and AAD bound", () => {
  const first = providers.encryptCredential("PLEX_SERVER_SECRET", ctx());
  const second = providers.encryptCredential("PLEX_SERVER_SECRET", ctx());
  assert.notEqual(first, second);
  assert.match(first, /^v1\.key-2026\./);
  assert.ok(!first.includes("PLEX_SERVER_SECRET"));
  assert.equal(providers.decryptCredential(first, ctx()), "PLEX_SERVER_SECRET");
  assert.throws(() => providers.decryptCredential(first, ctx(2)), /authenticate|AAD|Unsupported|unable/i);
  assert.throws(() => providers.decryptCredential(`${first.slice(0, -1)}${first.endsWith("A") ? "B" : "A"}`, ctx()));
});

test("resource URI parsing rejects credentials and non-http schemes without granting trust", () => {
  assert.equal(providers.validateDiscoveredPlexUri("https://plex.example:32400/web"), "https://plex.example:32400");
  assert.equal(providers.validateDiscoveredPlexUri("file:///etc/passwd"), null);
  assert.equal(providers.validateDiscoveredPlexUri("https://user:pass@plex.example"), null);
});

test("pinned provider DNS lookup honors Node's all-address callback contract", () => {
  const resolved = { address: "203.0.113.10", family: 4 };
  const lookup = providers.pinnedLookup(resolved);
  lookup("plex.tv", { all: true }, (error, addresses) => {
    assert.ifError(error);
    assert.deepEqual(addresses, [resolved]);
  });
  lookup("plex.tv", {}, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, resolved.address);
    assert.equal(family, resolved.family);
  });
});

test("provider transport refuses redirects, forbidden metadata addresses, oversized bodies, and overall timeout", async () => {
  const localPolicy = { allowedOrigins: [origin], allowedPrivateOrigins: [origin], allowTestLoopback: true, timeoutMs: 100, maxBodyBytes: 64 };
  await assert.rejects(() => providers.safeProviderFetch(`${origin}/redirect`, {}, localPolicy), /redirect/i);
  await assert.rejects(() => providers.safeProviderFetch("http://169.254.169.254/latest/meta-data", {}, { allowedOrigins: ["http://169.254.169.254"] }), /forbidden/i);
  await assert.rejects(() => providers.safeProviderFetch(`${origin}/large`, {}, localPolicy), /large/i);
  await assert.rejects(() => providers.safeProviderFetch(`${origin}/slow`, {}, { ...localPolicy, timeoutMs: 25 }), /timed out/i);
});

test("Plex PIN login filters machine IDs, verifies /identity, stores ciphertext, and consumes flow once", async () => {
  db.exec("DELETE FROM sessions; DELETE FROM connections; DELETE FROM provider_identities; DELETE FROM provider_flows; DELETE FROM invites; DELETE FROM users;");
  const server = await startTestServer();
  try {
    let response = await fetch(`${server.base}/api/auth/provider/plex/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login" }) });
    assert.equal(response.status, 200);
    const started = await response.json();
    const cookies = parseCookies(response);
    assert.ok(cookies.rs_provider);
    const cookie = `rs_provider=${cookies.rs_provider}`;
    response = await fetch(`${server.base}/api/auth/provider/plex/poll?state=${encodeURIComponent(started.state)}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const polled = await response.json();
    assert.deepEqual(Object.keys(polled.servers[0]).sort(), ["machine_id", "name", "selection_id"]);
    assert.equal(polled.servers[0].machine_id, "allowed-machine");
    assert.ok(!JSON.stringify(polled).includes(origin));
    assert.ok(!JSON.stringify(polled).includes("SECRET"));
    response = await fetch(`${server.base}/api/auth/provider/plex/complete`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: started.state, selection_id: polled.servers[0].selection_id }) });
    assert.equal(response.status, 200, await response.text());
    const row = db.prepare("SELECT * FROM connections WHERE service='plex'").get();
    assert.equal(row.server_machine_id, "allowed-machine");
    assert.equal(row.service_username, "Verified Plex");
    assert.equal(row.access_token, null);
    assert.equal(row.refresh_token, null);
    assert.ok(!row.credentials_encrypted.includes("PLEX_SERVER_SECRET"));
    assert.deepEqual(providers.decryptJson(row.credentials_encrypted, ctx(row.user_id)), { token: "PLEX_SERVER_SECRET", isOwner: true });
    const replay = await fetch(`${server.base}/api/auth/provider/plex/complete`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: started.state, selection_id: polled.servers[0].selection_id }) });
    assert.notEqual(replay.status, 200);
    assert.ok(requests.some((request) => request.url === "/identity"));
  } finally { await server.close(); }
});

test("provider identity uniqueness is immutable and never merges by display name", () => {
  const plex = db.prepare("SELECT * FROM provider_identities WHERE provider='plex'").get();
  const other = Number(db.prepare("INSERT INTO users (username,password_hash) VALUES ('other_user','hash')").run().lastInsertRowid);
  assert.throws(() => db.prepare("INSERT INTO provider_identities (provider,provider_user_id,user_id,display_name) VALUES ('plex',?,?,?)").run(plex.provider_user_id, other, "different"), /UNIQUE/);
  const traktIdentity = db.prepare("INSERT INTO provider_identities (provider,provider_user_id,user_id,display_name) VALUES ('trakt','444',?,'same_name')").run(other);
  assert.ok(traktIdentity.lastInsertRowid);
  assert.notEqual(other, plex.user_id);
});

test("Trakt exact callback URI and refresh-on-401 retry use Bearer tokens", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.base}/api/auth/provider/trakt/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login" }) });
    const data = await response.json();
    const authUrl = new URL(data.auth_url);
    assert.equal(authUrl.searchParams.get("redirect_uri"), "http://public.example/api/auth/provider/trakt/callback");
  } finally { await server.close(); }
  const result = await sync.traktHistoryWithRefresh({ accessToken: "OLD_TRAKT_SECRET", refreshToken: "REFRESH_SECRET" }, new Date(Date.now() + 3600000).toISOString());
  assert.deepEqual(result.items, []);
  assert.equal(result.credentials.accessToken, "NEW_TRAKT_SECRET");
  assert.ok(requests.some((request) => request.auth === "Bearer OLD_TRAKT_SECRET"));
  assert.ok(requests.some((request) => request.auth === "Bearer NEW_TRAKT_SECRET"));
});

test("provider history clients return stable event IDs and Plex uses event history plus bounded metadata resolution", async () => {
  traktHistoryPayload = [{ id: 7654, watched_at: "2020-01-01T00:00:00.000Z", movie: { ids: { tmdb: 700 } } }];
  const trakt = await sync.traktHistory("NEW_TRAKT_SECRET");
  assert.deepEqual(trakt, [{ tmdb_id: 700, watched_at: "2020-01-01T00:00:00.000Z", event_id: "7654" }]);
  traktHistoryPayload = [];

  const plex = await sync.plexWatchedMovies(origin, "PLEX_SERVER_SECRET", "allowed-machine");
  assert.deepEqual(plex.map((item) => [item.tmdb_id, item.event_id]), [
    [501, "/status/sessions/history/9001"],
    [502, "/status/sessions/history/9002"],
  ]);
  assert.ok(requests.some((request) => request.url.startsWith("/status/sessions/history/all?")));
  assert.ok(requests.some((request) => request.url === "/library/metadata/502?includeGuids=1"));
  assert.ok(!requests.some((request) => request.url.includes("/library/sections/")));
});

test("Plex history is account-scoped and rejects an ambiguous shared-user response", async () => {
  const normal = plexHistoryPayload;
  try {
    plexHistoryPayload = [
      { historyKey: "a", ratingKey: "501", viewedAt: 1577836800, accountID: 42, Guid: [{ id: "tmdb://501" }] },
      { historyKey: "b", ratingKey: "501", viewedAt: 1577836860, accountID: 43, Guid: [{ id: "tmdb://501" }] },
    ];
    await assert.rejects(
      () => sync.plexWatchedMovies(origin, "PLEX_SERVER_SECRET", "allowed-machine"),
      /multiple Plex accounts/i,
    );

    plexHistoryPayload = [
      { historyKey: "owner", ratingKey: "501", viewedAt: 1577836800, accountID: 1, Guid: [{ id: "tmdb://501" }] },
    ];
    await sync.plexWatchedMovies(origin, "PLEX_SERVER_SECRET", "allowed-machine", { accountId: 1 });
    assert.ok(requests.some((request) => request.url.includes("accountID=1")));
  } finally {
    plexHistoryPayload = normal;
  }
});

test("history clients fail closed on incomplete pagination, unresolved metadata, and missing immutable IDs", async () => {
  const oldTrakt = traktHistoryPayload;
  const oldPlex = plexHistoryPayload;
  try {
    traktHistoryPayload = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, watched_at: "2020-01-01T00:00:00Z", movie: { ids: { tmdb: index + 1 } },
    }));
    traktPageCount = 1001;
    await assert.rejects(() => sync.traktHistory("NEW_TRAKT_SECRET"), /safe pagination limit/i);

    plexHistoryPayload = oldPlex;
    plexTotalSize = 200001;
    await assert.rejects(() => sync.plexWatchedMovies(origin, "PLEX_SERVER_SECRET", "allowed-machine"), /safe pagination limit/i);

    plexTotalSize = null;
    plexHistoryPayload = [{ ratingKey: "501", viewedAt: 1577836800, accountID: 42, Guid: [{ id: "tmdb://501" }] }];
    await assert.rejects(() => sync.plexWatchedMovies(origin, "PLEX_SERVER_SECRET", "allowed-machine"), /immutable history ID/i);

    plexHistoryPayload = [{ historyKey: "missing-tmdb", ratingKey: "999", viewedAt: 1577836800, accountID: 42 }];
    await assert.rejects(() => sync.plexWatchedMovies(origin, "PLEX_SERVER_SECRET", "allowed-machine"), /no TMDB identity|Plex error 404/i);
  } finally {
    traktHistoryPayload = oldTrakt;
    traktPageCount = null;
    plexHistoryPayload = oldPlex;
    plexTotalSize = null;
  }
});

test("provider schema and connection DTOs contain no credential fields", async () => {
  const identitySql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_identities'").get().sql;
  assert.match(identitySql, /UNIQUE\(provider, provider_user_id\)/i);
  const server = await startTestServer();
  try {
    const user = db.prepare("SELECT * FROM users WHERE id=(SELECT user_id FROM connections WHERE service='plex')").get();
    const { createSession } = await import("../src/auth.js");
    const session = createSession(user.id);
    const response = await fetch(`${server.base}/api/connections`, { headers: { cookie: `session=${session.token}` } });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /token|credential|server_url|SECRET/i);
  } finally { await server.close(); }
});
