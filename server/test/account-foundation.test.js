process.env.DATA_DIR = `/tmp/rs-account-foundation-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.EMAIL_OUTBOX_ENCRYPTION_KEY = "test-outbox-key-that-is-independent-and-at-least-32-chars";
process.env.EMAIL_OUTBOX_ENCRYPTION_KEY_ID = "test-active";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";

const { db, tableExists } = await import("../src/db.js");
const {
  normalizeEmail,
  issueAccountToken,
  consumeAccountToken,
} = await import("../src/account-tokens.js");
const {
  enqueueEmailJob,
  getEmailJobForDelivery,
  CaptureEmailProvider,
  createOutboxCipher,
} = await import("../src/email.js");
const { issueAccountEmail } = await import("../src/account-email.js");

function createUser(username, email = null) {
  return Number(db.prepare(`
    INSERT INTO users (username, password_hash, email, email_normalized)
    VALUES (?, 'hash', ?, ?)
  `).run(username, email, email && normalizeEmail(email)).lastInsertRowid);
}

test("migration 5 adds nullable normalized email identity and public-account tables", () => {
  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((row) => row.name));
  assert.ok(columns.has("email"));
  assert.ok(columns.has("email_normalized"));
  assert.ok(columns.has("email_verified_at"));
  assert.ok(tableExists("account_tokens"));
  assert.ok(tableExists("email_jobs"));
  assert.ok(db.prepare("SELECT 1 FROM schema_versions WHERE version=5").get());
});

test("email normalization is trim plus lowercase only", () => {
  assert.equal(normalizeEmail("  Caleb+Movies@Example.COM  "), "caleb+movies@example.com");
  assert.equal(normalizeEmail(""), "");
});

test("multiple legacy users may retain null email while normalized emails are unique", () => {
  createUser("legacy-one");
  createUser("legacy-two");
  createUser("mail-one", "Person@Example.com");
  assert.throws(
    () => createUser("mail-two", " person@example.COM "),
    /unique/i
  );
});

test("database rejects missing or mismatched normalized email identity", () => {
  assert.throws(() => db.prepare(`
    INSERT INTO users (username,password_hash,email,email_normalized)
    VALUES ('missing-normalized','hash','person@example.com',NULL)
  `).run(), /email normalization/i);
  assert.throws(() => db.prepare(`
    INSERT INTO users (username,password_hash,email,email_normalized)
    VALUES ('mismatched-normalized','hash','person@example.com','other@example.com')
  `).run(), /email normalization/i);
  assert.throws(() => db.prepare(`
    INSERT INTO users (username,password_hash,email,email_normalized)
    VALUES ('normalized-without-email','hash',NULL,'person@example.com')
  `).run(), /email normalization/i);
});

test("account tokens store only a keyed digest, invalidate predecessors, and are one-use", () => {
  const userId = createUser("token-user", "token@example.com");
  const first = issueAccountToken({ userId, purpose: "verify_email", ttlMs: 10_000, now: 1_000 });
  const firstRow = db.prepare("SELECT * FROM account_tokens WHERE user_id=?").get(userId);
  assert.ok(first.token.length >= 43);
  assert.equal(JSON.stringify(firstRow).includes(first.token), false);
  assert.notEqual(firstRow.token_digest, first.token);

  const second = issueAccountToken({ userId, purpose: "verify_email", ttlMs: 10_000, now: 2_000 });
  assert.equal(consumeAccountToken({ token: second.token, purpose: "password_reset", now: 2_001 }), null);
  assert.equal(consumeAccountToken({ token: first.token, purpose: "verify_email", now: 2_001 }), null);
  assert.deepEqual(
    consumeAccountToken({ token: second.token, purpose: "verify_email", now: 2_001 }),
    { userId, purpose: "verify_email" }
  );
  assert.equal(consumeAccountToken({ token: second.token, purpose: "verify_email", now: 2_002 }), null);
});

test("account token expiry uses exact integer epoch-millisecond semantics", () => {
  const userId = createUser("expiry-user", "expiry@example.com");
  const before = issueAccountToken({ userId, purpose: "password_reset", ttlMs: 100, now: 10_000 });
  assert.ok(consumeAccountToken({ token: before.token, purpose: "password_reset", now: 10_099 }));

  const exact = issueAccountToken({ userId, purpose: "password_reset", ttlMs: 100, now: 20_000 });
  assert.equal(consumeAccountToken({ token: exact.token, purpose: "password_reset", now: 20_100 }), null);

  const after = issueAccountToken({ userId, purpose: "password_reset", ttlMs: 100, now: 30_000 });
  assert.equal(consumeAccountToken({ token: after.token, purpose: "password_reset", now: 30_101 }), null);
});

test("email outbox encrypts bearer payloads, survives a second database connection, and returns safe DTOs", async () => {
  const userId = createUser("email-user", "email@example.com");
  const rawToken = "raw-bearer-token-that-must-not-be-in-sqlite";
  const queued = enqueueEmailJob({
    userId,
    recipient: "email@example.com",
    kind: "email_verification",
    payload: { verifyUrl: `https://reelscore.example/verify?token=${rawToken}` },
    idempotencyKey: "verify/email-user/1",
    now: 40_000,
  });
  assert.equal("payload_encrypted" in queued, false);
  assert.equal("payload" in queued, false);

  const stored = db.prepare("SELECT * FROM email_jobs WHERE id=?").get(queued.id);
  assert.equal(JSON.stringify(stored).includes(rawToken), false);

  const reopened = new Database(path.join(process.env.DATA_DIR, "reelscore.db"), { readonly: true });
  const durable = reopened.prepare("SELECT state, kind, payload_encrypted FROM email_jobs WHERE id=?").get(queued.id);
  reopened.close();
  assert.equal(durable.state, "queued");
  assert.equal(durable.kind, "email_verification");
  assert.equal(JSON.stringify(durable).includes(rawToken), false);

  const delivery = getEmailJobForDelivery(queued.id);
  assert.equal(delivery.payload.verifyUrl.endsWith(rawToken), true);
  assert.equal("payload_encrypted" in delivery, false);

  const capture = new CaptureEmailProvider();
  const receipt = await capture.send({
    idempotencyKey: queued.idempotency_key,
    to: { email: delivery.recipient },
    subject: "Verify your ReelScore account",
    text: delivery.payload.verifyUrl,
  });
  assert.equal(receipt.status, "accepted");
  assert.equal(capture.messages.length, 1);
});

test("outbox key rotation decrypts with an explicit previous key and rejects missing or tampered metadata", () => {
  const oldSecret = "old-independent-outbox-secret-that-is-at-least-32-chars";
  const newSecret = "new-independent-outbox-secret-that-is-at-least-32-chars";
  const metadata = { kind: "email_verification", recipient: "rotate@example.com", idempotencyKey: "rotate/1" };
  const oldCipher = createOutboxCipher({ activeKeyId: "old", activeSecret: oldSecret, previousKeys: {} });
  const envelope = oldCipher.encrypt({ token: "bearer" }, metadata);
  const rotated = createOutboxCipher({ activeKeyId: "new", activeSecret: newSecret, previousKeys: { old: oldSecret } });
  assert.deepEqual(rotated.decrypt(envelope, metadata), { token: "bearer" });
  const withoutOld = createOutboxCipher({ activeKeyId: "new", activeSecret: newSecret, previousKeys: {} });
  assert.throws(() => withoutOld.decrypt(envelope, metadata), /unavailable/i);
  assert.throws(() => rotated.decrypt(envelope, { ...metadata, recipient: "other@example.com" }));

  const parsed = JSON.parse(envelope);
  parsed.tag = `${parsed.tag.startsWith("A") ? "B" : "A"}${parsed.tag.slice(1)}`;
  assert.throws(() => rotated.decrypt(JSON.stringify(parsed), metadata));
});

test("email jobs reject malformed recipients and duplicate idempotency keys", () => {
  const userId = createUser("recipient-user", "recipient@example.com");
  for (const recipient of ["victim@example.com\r\nBcc: attacker@example.com", "a@example.com,b@example.com", "missing-domain@", "@missing-local.example", "nul\0@example.com"]) {
    assert.throws(() => enqueueEmailJob({
      userId,
      recipient,
      kind: "password_reset",
      payload: { url: "https://reelscore.example/reset" },
      idempotencyKey: `invalid/${Buffer.from(recipient).toString("hex")}`,
    }), /recipient/i);
  }
  enqueueEmailJob({
    userId,
    recipient: "recipient@example.com",
    kind: "password_reset",
    payload: { url: "https://reelscore.example/reset/1" },
    idempotencyKey: "duplicate/job",
  });
  assert.throws(() => enqueueEmailJob({
    userId,
    recipient: "recipient@example.com",
    kind: "password_reset",
    payload: { url: "https://reelscore.example/reset/2" },
    idempotencyKey: "duplicate/job",
  }), /unique/i);
});

test("atomic account-email issuance rolls back token replacement when outbox insertion fails", () => {
  const userId = createUser("atomic-user", "atomic@example.com");
  const original = issueAccountToken({ userId, purpose: "verify_email", ttlMs: 10_000, now: 50_000 });
  assert.throws(() => issueAccountEmail({
    userId,
    recipient: "atomic@example.com",
    purpose: "verify_email",
    publicUrl: "https://reelscore.example",
    now: 51_000,
    enqueue: () => { throw new Error("injected outbox failure"); },
  }), /injected outbox failure/);
  assert.deepEqual(
    consumeAccountToken({ token: original.token, purpose: "verify_email", now: 51_001 }),
    { userId, purpose: "verify_email" },
  );
});
