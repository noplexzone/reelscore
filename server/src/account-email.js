import { db } from "./db.js";
import { issueAccountToken } from "./account-tokens.js";
import { enqueueEmailJob } from "./email.js";

const SETTINGS = {
  verify_email: {
    ttlMs: 24 * 60 * 60 * 1000,
    route: "verify-email",
    kind: "email_verification",
  },
  password_reset: {
    ttlMs: 60 * 60 * 1000,
    route: "reset-password",
    kind: "password_reset",
  },
};

export function issueAccountEmail({
  userId,
  recipient,
  purpose,
  publicUrl,
  priority = 10,
  now = Date.now(),
  enqueue = enqueueEmailJob,
}) {
  const settings = SETTINGS[purpose];
  if (!settings) throw new TypeError("Unsupported account email purpose.");
  const origin = new URL(publicUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Account email public URL must be an HTTPS origin.");
  }

  return db.transaction(() => {
    const issued = issueAccountToken({ userId, purpose, ttlMs: settings.ttlMs, now });
    const url = `${origin.origin}/${settings.route}?token=${encodeURIComponent(issued.token)}`;
    const job = enqueue({
      userId,
      recipient,
      kind: settings.kind,
      payload: { url, expiresAt: issued.expiresAt },
      priority,
      idempotencyKey: `${settings.kind}/${issued.id}`,
      now,
    });
    return { tokenId: issued.id, expiresAt: issued.expiresAt, job };
  })();
}
