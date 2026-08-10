import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { db } from "./db.js";
import {
  EMAIL_OUTBOX_ENCRYPTION_KEY,
  EMAIL_OUTBOX_ENCRYPTION_KEY_ID,
  EMAIL_OUTBOX_ENCRYPTION_PREVIOUS_KEYS,
} from "./config.js";

const AAD_VERSION = "reelscore-email-outbox:v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const LOCAL_PART_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function requireSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Email outbox encryption key is not configured safely.");
  }
  return secret;
}

function keyFrom(secret) {
  return createHash("sha256")
    .update(`${AAD_VERSION}\0`, "utf8")
    .update(requireSecret(secret), "utf8")
    .digest();
}

function aadFor({ kind, recipient, idempotencyKey }, keyId) {
  return Buffer.from(`${AAD_VERSION}\0${keyId}\0${kind}\0${recipient}\0${idempotencyKey}`, "utf8");
}

export function normalizeEmailRecipient(value) {
  const recipient = String(value ?? "").trim();
  if (!recipient || recipient.length > 254 || /[^\x20-\x7E]/.test(recipient)) {
    throw new TypeError("Email recipient is invalid.");
  }
  const separator = recipient.indexOf("@");
  if (separator <= 0 || separator !== recipient.lastIndexOf("@")) {
    throw new TypeError("Email recipient is invalid.");
  }
  const local = recipient.slice(0, separator);
  const domain = recipient.slice(separator + 1);
  const labels = domain.split(".");
  if (!LOCAL_PART_PATTERN.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..") || labels.length < 2 || labels.some((label) => !LABEL_PATTERN.test(label))) {
    throw new TypeError("Email recipient is invalid.");
  }
  return recipient;
}

export function createOutboxCipher({ activeKeyId, activeSecret, previousKeys = {} }) {
  if (!KEY_ID_PATTERN.test(String(activeKeyId || ""))) throw new Error("Email outbox key ID is invalid.");
  requireSecret(activeSecret);
  if (!previousKeys || Array.isArray(previousKeys) || typeof previousKeys !== "object") {
    throw new Error("Email outbox previous keys are invalid.");
  }
  const secrets = { ...previousKeys, [activeKeyId]: activeSecret };
  for (const [keyId, secret] of Object.entries(secrets)) {
    if (!KEY_ID_PATTERN.test(keyId)) throw new Error("Email outbox key ID is invalid.");
    requireSecret(secret);
  }

  return {
    encrypt(payload, metadata) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Email payload must be an object.");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyFrom(activeSecret), iv);
      cipher.setAAD(aadFor(metadata, activeKeyId));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      return JSON.stringify({
        v: 1,
        kid: activeKeyId,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      });
    },

    decrypt(envelopeText, metadata) {
      const envelope = JSON.parse(envelopeText);
      if (envelope?.v !== 1 || !KEY_ID_PATTERN.test(String(envelope.kid || "")) || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
        throw new Error("Unsupported email payload envelope.");
      }
      const secret = secrets[envelope.kid];
      if (!secret) throw new Error("Email outbox encryption key is unavailable.");
      const iv = Buffer.from(envelope.iv, "base64url");
      const tag = Buffer.from(envelope.tag, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid email payload envelope.");
      const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
      decipher.setAAD(aadFor(metadata, envelope.kid));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    },
  };
}

const defaultCipher = createOutboxCipher({
  activeKeyId: EMAIL_OUTBOX_ENCRYPTION_KEY_ID,
  activeSecret: EMAIL_OUTBOX_ENCRYPTION_KEY,
  previousKeys: EMAIL_OUTBOX_ENCRYPTION_PREVIOUS_KEYS,
});

function safeJob(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    recipient: row.recipient,
    kind: row.kind,
    idempotency_key: row.idempotency_key,
    state: row.state,
    priority: row.priority,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    provider_message_id: row.provider_message_id,
    last_error_code: row.last_error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sent_at: row.sent_at,
  };
}

export function enqueueEmailJob({
  userId = null,
  recipient,
  kind,
  payload,
  priority = 100,
  idempotencyKey = randomUUID(),
  now = Date.now(),
}) {
  const normalizedRecipient = normalizeEmailRecipient(recipient);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(String(kind || ""))) throw new TypeError("Email kind is invalid.");
  if (!Number.isSafeInteger(priority)) throw new TypeError("Email priority must be an integer.");
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be integer epoch milliseconds.");
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 255) throw new TypeError("Email idempotency key is invalid.");

  const metadata = { kind, recipient: normalizedRecipient, idempotencyKey };
  const encrypted = defaultCipher.encrypt(payload, metadata);
  const result = db.prepare(`
    INSERT INTO email_jobs (
      user_id, recipient, kind, payload_encrypted, idempotency_key,
      priority, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, normalizedRecipient, kind, encrypted, idempotencyKey, priority, now, now, now);
  const row = db.prepare("SELECT * FROM email_jobs WHERE id=?").get(result.lastInsertRowid);
  return safeJob(row);
}

export function getEmailJobForDelivery(id) {
  const row = db.prepare("SELECT * FROM email_jobs WHERE id=?").get(id);
  if (!row) return null;
  const metadata = {
    kind: row.kind,
    recipient: row.recipient,
    idempotencyKey: row.idempotency_key,
  };
  return { ...safeJob(row), payload: defaultCipher.decrypt(row.payload_encrypted, metadata) };
}

export class CaptureEmailProvider {
  constructor() {
    this.messages = [];
    this.receipts = new Map();
  }

  async send(message) {
    if (!message?.idempotencyKey) throw new TypeError("Email idempotency key is required.");
    const existing = this.receipts.get(message.idempotencyKey);
    if (existing) return existing;
    const receipt = {
      providerMessageId: `capture_${this.messages.length + 1}`,
      status: "accepted",
      acceptedAt: new Date(),
    };
    this.messages.push(structuredClone(message));
    this.receipts.set(message.idempotencyKey, receipt);
    return receipt;
  }
}
