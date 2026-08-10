import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const ACTIVE_KEY_ID = process.env.CREDENTIAL_ENCRYPTION_KEY_ID || "active";
export const ACTIVE_CREDENTIAL_KEY_ID = ACTIVE_KEY_ID;
const activeSecret = process.env.CREDENTIAL_ENCRYPTION_KEY || (process.env.APP_MODE === "hosted" ? "" : "reelscore-local-provider-key-change-me");
let previous = {};
try { previous = JSON.parse(process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS || "{}"); } catch { throw new Error("[reelscore] CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object."); }
const keySecrets = { ...previous, ...(activeSecret ? { [ACTIVE_KEY_ID]: activeSecret } : {}) };
const keyFor = (id) => keySecrets[id] ? createHash("sha256").update(String(keySecrets[id])).digest() : null;

export const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 10000);
export const PROVIDER_CONNECT_TIMEOUT_MS = Number(process.env.PROVIDER_CONNECT_TIMEOUT_MS || 3000);
export const PROVIDER_DNS_TIMEOUT_MS = Number(process.env.PROVIDER_DNS_TIMEOUT_MS || 2000);
export const PROVIDER_MAX_BODY_BYTES = Number(process.env.PROVIDER_MAX_BODY_BYTES || 1024 * 1024);

export function credentialAad({ userId, connectionId, provider, field }) {
  if (userId == null || !connectionId || !provider || !field) throw new Error("Credential AAD context is incomplete.");
  return `reelscore|user=${userId}|connection=${connectionId}|provider=${provider}|field=${field}`;
}

export function encryptCredential(value, context) {
  const key = keyFor(ACTIVE_KEY_ID);
  if (!key) throw new Error("Credential encryption is not configured.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(credentialAad(context)));
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", ACTIVE_KEY_ID, nonce.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptCredential(envelope, context) {
  const [version, keyId, nonce, tag, ciphertext, extra] = String(envelope || "").split(".");
  if (version !== "v1" || !keyId || !nonce || !tag || ciphertext === undefined || extra !== undefined) throw new Error("Invalid encrypted credential envelope.");
  const key = keyFor(keyId);
  if (!key) throw new Error("Credential encryption key is unavailable.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(credentialAad(context)));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export const encryptJson = (value, context) => encryptCredential(JSON.stringify(value), context);
export const decryptJson = (value, context) => JSON.parse(decryptCredential(value, context));
export function credentialEnvelopeKeyId(envelope) {
  const [version, keyId] = String(envelope || "").split(".");
  return version === "v1" && keyId ? keyId : null;
}

export function parseAllowedOrigins(raw = process.env.PLEX_ALLOWED_ORIGINS || "") {
  return String(raw).split(",").map((v) => v.trim()).filter(Boolean).map((value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("PLEX_ALLOWED_ORIGINS entries must be HTTP(S) origins.");
    return url.origin;
  });
}

export function validateDiscoveredPlexUri(raw) {
  try {
    const url = new URL(String(raw));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (!url.hostname || url.port === "0") return null;
    return url.origin;
  } catch { return null; }
}

function ipv4Number(ip) { return ip.split(".").reduce((n, part) => (n * 256) + Number(part), 0) >>> 0; }
function inV4(ip, base, bits) { const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask); }
function addressClass(address) {
  const family = net.isIP(address);
  if (!family) return "invalid";
  if (family === 4) {
    if (inV4(address, "0.0.0.0", 8) || inV4(address, "127.0.0.0", 8) || inV4(address, "169.254.0.0", 16) ||
        inV4(address, "192.0.0.0", 24) || inV4(address, "192.0.2.0", 24) || inV4(address, "198.18.0.0", 15) ||
        inV4(address, "198.51.100.0", 24) || inV4(address, "203.0.113.0", 24) || inV4(address, "224.0.0.0", 4)) return "forbidden";
    if (inV4(address, "10.0.0.0", 8) || inV4(address, "172.16.0.0", 12) || inV4(address, "192.168.0.0", 16) || inV4(address, "100.64.0.0", 10)) return "private";
    return "public";
  }
  const ip = address.toLowerCase().split("%")[0];
  if (ip === "::" || ip === "::1" || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb") || ip.startsWith("ff") || ip.startsWith("2001:db8")) return "forbidden";
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private";
  if (ip.startsWith("::ffff:")) return addressClass(ip.slice(7));
  return "public";
}

async function boundedLookup(hostname, policy) {
  const lookup = dns.lookup(hostname, { all: true, verbatim: true });
  const records = await Promise.race([lookup, new Promise((_, reject) => setTimeout(() => reject(new Error("Provider DNS lookup timed out.")), policy.dnsTimeoutMs))]);
  if (!records.length) throw new Error("Provider host did not resolve.");
  for (const record of records) {
    const kind = addressClass(record.address);
    if (kind === "forbidden" && !(policy.allowTestLoopback && process.env.NODE_ENV === "test" && record.address === "127.0.0.1")) throw new Error("Provider host resolves to a forbidden address.");
    if (kind === "private" && !policy.privateOriginAllowed) throw new Error("Provider host resolves to a private address.");
    if (kind === "invalid") throw new Error("Provider host resolved to an invalid address.");
  }
  return records[0];
}

export function pinnedLookup(resolved) {
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, [resolved]);
    return callback(null, resolved.address, resolved.family);
  };
}

export async function safeProviderFetch(rawUrl, options = {}, settings = {}) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Provider URL is invalid.");
  const allowedOrigins = settings.allowedOrigins || [];
  if (!allowedOrigins.includes(url.origin)) throw new Error("Provider URL is not allowed.");
  const policy = {
    dnsTimeoutMs: settings.dnsTimeoutMs || PROVIDER_DNS_TIMEOUT_MS,
    connectTimeoutMs: settings.connectTimeoutMs || PROVIDER_CONNECT_TIMEOUT_MS,
    timeoutMs: settings.timeoutMs || PROVIDER_TIMEOUT_MS,
    maxBodyBytes: settings.maxBodyBytes || PROVIDER_MAX_BODY_BYTES,
    privateOriginAllowed: (settings.allowedPrivateOrigins || []).includes(url.origin),
    allowTestLoopback: !!settings.allowTestLoopback,
  };
  const resolved = await boundedLookup(url.hostname, policy);
  const transport = url.protocol === "https:" ? https : http;
  const body = options.body == null ? null : Buffer.from(String(options.body));
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    const overall = setTimeout(() => {
      const error = new Error("Provider request timed out.");
      req?.destroy(error);
      fail(error);
    }, policy.timeoutMs);
    req = transport.request(url, {
      method: options.method || "GET",
      headers: { Connection: "close", ...(options.headers || {}) },
      signal: options.signal,
      lookup: pinnedLookup(resolved),
      servername: url.hostname,
    }, (res) => {
      if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400) { res.resume(); clearTimeout(overall); return fail(new Error("Provider redirect refused.")); }
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > policy.maxBodyBytes) { res.destroy(); clearTimeout(overall); return fail(new Error("Provider response is too large.")); }
      const chunks = []; let size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size > policy.maxBodyBytes) res.destroy(new Error("Provider response is too large.")); else chunks.push(chunk); });
      res.on("error", (error) => { clearTimeout(overall); fail(error); });
      res.on("end", () => {
        clearTimeout(overall);
        if (settled) return;
        settled = true;
        const payload = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, headers: res.headers, text: async () => payload, json: async () => { try { return JSON.parse(payload); } catch { throw new Error("Provider returned invalid JSON."); } } });
      });
    });
    req.setTimeout(policy.connectTimeoutMs, () => req.destroy(new Error("Provider connection timed out.")));
    req.on("error", (error) => { clearTimeout(overall); fail(error); });
    if (body) req.write(body);
    req.end();
  });
}

export async function providerJson(url, options, policy) {
  const response = await safeProviderFetch(url, options, policy);
  if (!response.ok) { const error = new Error(`Provider request failed (${response.status}).`); error.status = response.status; throw error; }
  return response.json();
}

export const plexHeaders = (token) => ({ Accept: "application/json", ...(token ? { "X-Plex-Token": token } : {}), "X-Plex-Product": "ReelScore", "X-Plex-Version": "1.0", "X-Plex-Client-Identifier": process.env.PLEX_CLIENT_IDENTIFIER || process.env.PLEX_CLIENT_ID || "reelscore-self-hosted" });
