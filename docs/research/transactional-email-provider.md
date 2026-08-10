# Transactional email provider recommendation

Researched against official provider documentation on **2026-07-28**. Scope: ReelScore's first 100 public users; no provider accounts were created and no charges were incurred.

## Decision

**Use Resend Free initially, through a provider-neutral HTTP API adapter.**

It is the best fit for this stage because its free tier includes 3,000 transactional emails/month (hard cap 100/day), one custom domain, REST API and SMTP, automatic suppression, all webhook event types, signed webhook requests, one webhook endpoint, and 30-day data retention. Its HTTP API supports idempotency keys, and its webhook delivery has automatic retries and manual replay. This is materially less operational work than Amazon SES and gives better troubleshooting retention than Mailgun Free.

Use a dedicated sending subdomain such as `mail.<reelscore-domain>` or `updates.<reelscore-domain>`, with a sender such as `ReelScore <notifications@mail.<reelscore-domain>>`. Keep provider-generated DKIM/SPF/MX records **DNS-only** in Cloudflare. Add DMARC deliberately (start with monitoring, then tighten after confirming alignment). A subdomain isolates transactional reputation from the root domain.

### Capacity guardrail

Free is suitable only while ReelScore stays comfortably below both limits. Registration verification, password reset, security mail, and deduplicated sync-failure notifications should normally fit for 100 users, but a launch burst can hit the 100/day cap. Therefore:

- enqueue mail in a durable database outbox rather than sending inline with HTTP requests;
- give verification/reset/security mail higher priority than sync-failure notices;
- collapse repeated sync failures into at most one notice per user/problem window (recommended: one initial notice, then no more than one reminder per 24 hours until recovery; optionally send a recovery notice);
- alert at 75 sent/queued messages in a UTC day and at 2,250 in a month;
- upgrade to **Resend Pro ($20/month, 50,000/month, no daily limit)** before a campaign, migration, or sustained workload could exceed the free daily cap. Do not wait for production auth mail to be rejected.

## Current comparison

| Provider | Low-volume price | Domain/sender setup | API / SMTP | Delivery events and webhooks | Operational fit for ReelScore |
|---|---:|---|---|---|---|
| **Resend** | **Free:** 3,000/month and 100/day. **Pro:** $20/month for 50,000; paid overage $0.90/1,000. | Must own and verify a domain. Free includes one domain. Recommends a sending subdomain; provides DKIM/SPF and DMARC support. | REST API, official SDKs, and SMTP. API/SMTP support idempotency. Initial API rate limit is 10 requests/sec/team. | Free includes one signed webhook endpoint, all events, retries/replay, automatic suppression, bounce details, and 30-day retention. | **Best balance.** No charge at expected volume, simple integration, strong webhook security and enough logs. Hard 100/day cap is the main risk. |
| **Postmark** | **Free:** only 100/month, no overage. **Basic:** $15/month for 10,000; $1.80/1,000 overage. | Sender signature or domain; domain verification with DKIM and custom Return-Path is recommended. | REST API, SMTP, official SDKs. | Event webhooks, secure endpoints, suppression, detailed analytics, and 45-day full-message retention. Retry schedules are documented. | Excellent transactional focus and low operational burden, but the free tier is an integration trial rather than enough production capacity for 100 users. Best paid fallback if delivery support/troubleshooting is valued over Resend's free allowance. |
| **Amazon SES** | **Essentials:** $0.16/1,000 outbound emails at 0–10M/month (about $0.48 for 3,000), plus attachment data and any SNS/EventBridge/CloudWatch usage. AWS free credits may apply to new customers. | Verify domain/email identities per AWS Region. New accounts start in a per-region sandbox and may send only to verified recipients, max 200/day and 1/sec, until production access is approved. | AWS API and regional SMTP credentials/endpoints. | Configuration sets publish to CloudWatch, Firehose, EventBridge, Pinpoint, or SNS; a public app webhook normally requires SNS/EventBridge plumbing and IAM configuration. | Cheapest raw send cost, but disproportionate setup and monitoring burden at 100 users: IAM, region-specific identities, sandbox approval, config sets, and extra AWS event services. Reconsider if ReelScore already standardizes on AWS or reaches meaningful volume. |
| **Mailgun** | **Free:** 100/day. **Basic:** $15/month for 10,000; from $1.80/1,000 overage. | Free/Basic include one custom sending domain and SPF/DKIM/DMARC authentication support. | REST API and SMTP; Mailgun recommends HTTP API for applications. | Tracking, analytics, signed webhooks, suppression; Free and Basic retain logs/bounce classification for only one day. | Cap and paid entry are similar to Resend's, but one-day logs are a notable troubleshooting disadvantage. More useful when inbound routing or EU-region options are priorities. |
| **Brevo** | **Free forever:** 300/day, no card, unused allowance does not roll over. Sending starts after account approval. | Register a sender and authenticate an owned domain with ownership TXT, DKIM, and DMARC records. | REST API and SMTP. | Transactional webhooks and unlimited log retention are included across plans. | Best free headroom, but it is a broader marketing/CRM product with more product surface, sending approval, and free-plan mail includes a **Sent by Brevo** footer. Good contingency if Resend's 100/day cap becomes a problem and a paid plan is not acceptable, but not the cleanest security-mail experience. |

### Deliverability assessment

At this volume, a dedicated IP is unnecessary and can be worse because ReelScore cannot warm it with stable volume. All candidates offer authenticated domains and shared sending infrastructure. Provider choice alone cannot guarantee inbox placement; the practical controls are:

1. verify DKIM and SPF and publish DMARC;
2. use a stable dedicated transactional subdomain and consistent From address;
3. disable open/click tracking for verification, password-reset, and security mail (fewer rewritten links and less privacy exposure);
4. process hard bounces and complaints immediately and stop sending nonessential notices to suppressed addresses;
5. never send test traffic to fabricated addresses—use provider test addresses/sandbox facilities;
6. keep reset/verification links HTTPS, single-use, short-lived, and free of secrets in analytics/logging.

## Provider-neutral adapter contract

The current repository is Node.js ESM, so this contract is expressed in JavaScript/JSDoc terms. Business/auth code must depend only on this interface; the Resend SDK belongs inside one adapter module.

```js
/**
 * @typedef {'email_verification'|'password_reset'|'security_alert'|
 *           'sync_failure'|'sync_recovered'} EmailKind
 *
 * @typedef {Object} EmailMessage
 * @property {string} idempotencyKey   // globally unique, stable across retries
 * @property {EmailKind} kind
 * @property {{email:string, name?:string}} to
 * @property {{email:string, name:string}} from
 * @property {{email:string, name?:string}=} replyTo
 * @property {string} subject
 * @property {string} text             // always present
 * @property {string=} html
 * @property {Record<string,string>=} tags // no tokens, passwords, or PII
 *
 * @typedef {Object} SendReceipt
 * @property {string} providerMessageId
 * @property {'accepted'} status       // provider accepted; not proof of delivery
 * @property {Date} acceptedAt
 *
 * @typedef {'accepted'|'delivered'|'deferred'|'bounced'|'complained'|
 *           'rejected'} DeliveryStatus
 *
 * @typedef {Object} DeliveryEvent
 * @property {string} eventId           // dedupe webhook retries/replays
 * @property {string} providerMessageId
 * @property {DeliveryStatus} status
 * @property {Date} occurredAt
 * @property {boolean=} permanent       // meaningful for bounce/rejection
 * @property {string=} reason           // sanitized; do not expose raw provider text
 * @property {string=} recipient
 *
 * @interface TransactionalEmailProvider
 * @method Promise<SendReceipt> send(EmailMessage message)
 * @method Promise<DeliveryEvent> verifyAndParseWebhook(Buffer rawBody,
 *         Record<string,string|string[]> headers)
 */
```

### Error contract

`send()` should throw only typed adapter errors:

- `EmailValidationError` — malformed/unsupported message; permanent, never retry;
- `EmailAuthenticationError` — invalid key or unverified sender/domain; permanent until operator action;
- `EmailRateLimitError` — transient; includes `retryAfter` where available;
- `EmailProviderUnavailableError` — timeout, network, or provider 5xx; transient;
- `EmailRejectedError` — provider rejected recipient/content; permanent for this message;
- `EmailConfigurationError` — missing environment variables or invalid startup configuration.

The adapter must set request timeouts, map provider responses to those errors, pass the stable idempotency key to Resend, return only after provider acceptance, and never log API keys, verification/reset tokens, full rendered bodies, or raw webhook payloads.

### Outbox and webhook behavior (application layer)

The adapter does not own retries. The application should:

1. create the verification/reset/security state change and an `email_outbox` row in the same SQLite transaction;
2. claim queued rows safely, render a versioned local template, then call `send()`;
3. use exponential backoff with jitter for transient errors, honor `retryAfter`, and dead-letter after a bounded number of attempts;
4. use a stable idempotency key such as `email/<outbox-id>/<template-version>` so worker crashes cannot duplicate sends;
5. expose a public HTTPS webhook route through Cloudflare, preserve the **raw body**, verify the Resend/Svix signature before JSON parsing, reject stale/replayed signatures, and deduplicate by `eventId`;
6. acknowledge valid webhook events quickly, then process them asynchronously;
7. record accepted/delivered/deferred/bounced/complained/rejected state; suppress nonessential notices after permanent bounce or complaint;
8. do not mark an account verified because an email was delivered—only the user's single-use verification token can do that.

### Configuration boundary

```text
EMAIL_PROVIDER=resend
EMAIL_API_KEY=                 # secret, runtime only
EMAIL_WEBHOOK_SECRET=          # separate secret, runtime only
EMAIL_FROM_NAME=ReelScore
EMAIL_FROM_ADDRESS=notifications@mail.<reelscore-domain>
EMAIL_REPLY_TO=                # optional monitored mailbox
PUBLIC_APP_URL=https://<public-reelscore-host>
```

Validate required configuration at startup in public-registration mode. A public deployment must fail closed (or visibly disable registration) if email is not configured; it must not create accounts that can never receive verification or password-reset mail.

## Rollout checklist

1. Choose the transactional subdomain; add it to Resend.
2. Add provider-generated DKIM/SPF/MX records in Cloudflare as DNS-only; add/confirm DMARC; verify the domain.
3. Create a send-only API key and separate webhook signing secret; inject them as container secrets/environment, never into the image or repository.
4. Implement the adapter, durable outbox, templates, quotas/priority, and signed webhook endpoint.
5. Test provider success, duplicate idempotency keys, 429/5xx retry mapping, hard bounce, complaint, invalid signature, replayed event, expired token, and queue recovery after restart.
6. Send real tests to controlled Gmail/Outlook addresses and inspect headers for `dkim=pass`, `spf=pass`, and `dmarc=pass`; check text and HTML rendering and spam placement.
7. Monitor daily/monthly usage, outbox age, send failures, bounce/complaint rates, and webhook failures. Upgrade before the free cap blocks auth/security mail.

## Official sources

- Resend: [pricing](https://resend.com/pricing), [quotas/rate and reputation limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [domain management](https://resend.com/docs/dashboard/domains/introduction), [Cloudflare setup](https://resend.com/docs/knowledge-base/cloudflare), [SMTP](https://resend.com/docs/send-with-smtp), [webhooks](https://resend.com/docs/dashboard/webhooks/introduction), [signature verification](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests), [retries/replays](https://resend.com/docs/webhooks/retries-and-replays).
- Postmark: [pricing](https://postmarkapp.com/pricing), [sender signatures](https://postmarkapp.com/developer/user-guide/managing-your-account/managing-sender-signatures), [webhooks/retries](https://postmarkapp.com/developer/webhooks/webhooks-overview), [API overview](https://postmarkapp.com/developer/api/overview).
- Amazon SES: [pricing](https://aws.amazon.com/ses/pricing/), [sandbox/production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [identity verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), [SMTP](https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html), [event destinations](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination.html).
- Mailgun: [pricing](https://www.mailgun.com/pricing/), [webhook security](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks).
- Brevo: [pricing](https://www.brevo.com/pricing/), [free-plan details](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans), [transactional API](https://developers.brevo.com/docs/send-a-transactional-email), [transactional webhooks](https://developers.brevo.com/docs/transactional-webhooks), [domain authentication](https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-record-DMARC-record).
- Cloudflare: [proxy status/DNS-only email verification records](https://developers.cloudflare.com/dns/proxy-status/), [email DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/email-records/).
