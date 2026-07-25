# Architecture

## Trust boundary

HayaSend is single-tenant by default. The API, queues, metadata, SES identity,
and delivery events live in the customer's AWS account. There is no Haya
control plane in the data path.

The bootstrap bearer key is generated or supplied in Secrets Manager. Only the
API function receives permission to read its value. The function retrieves and
briefly caches it only when bootstrap authentication is attempted; ordinary
application-key requests do not depend on Secrets Manager. Application keys
are stored as SHA-256 hashes with explicit scopes, optional expiry, and
revocation.

## Send path

1. The HTTP API authenticates and validates a Resend-shaped request. Larger
   attachments first use a 15-minute, SHA-256-bound presigned S3 PUT and are
   then referenced by opaque attachment ID.
2. DynamoDB claims the idempotency key and stores the email in one transaction.
3. The suppression list is checked before SQS accepts an immediate or
   short-delay job. Delays beyond 15 minutes use a self-deleting EventBridge
   Scheduler entry that targets the same queue.
4. The worker reloads current state, rechecks suppressions, and verifies
   attachment size and SHA-256 immediately before calling SES v2, so a newly
   suppressed recipient or corrupted attachment cannot be delivered.
5. SES events arrive through SNS and update the record.
6. Matching webhook deliveries return to SQS, so webhook failure cannot cause
   the email to be sent twice.

SQS and Lambda are at-least-once systems. HayaSend therefore treats the email
record as the source of truth and refuses to process a job after the record
reaches a final state. An atomic send lease prevents concurrent workers from
sending the same queued record.

Scheduler names are derived from email IDs. Rescheduling replaces the same
one-time schedule, cancellation deletes it, and stale SQS deliveries reload
the current DynamoDB record before doing any work.

There is still an unavoidable narrow failure window if SES accepts a message
and the worker stops before recording the provider ID. A later retry can
produce a duplicate. HayaSend documents this at-least-once boundary instead
of claiming exactly-once delivery; eliminating it would require provider-side
idempotency that SES does not currently expose.

## Data model

A single DynamoDB table stores typed entities:

- `EMAIL#<id>`
- `ATTACHMENT#<id>`
- `RECEIVED#<id>`
- `RECEIVED_CLAIM#<id>`
- `DOMAIN#<id>`
- `WEBHOOK#<id>`
- `IDEMPOTENCY#<sha256>`
- `APIKEY#<id>`
- `SUPPRESSION#<sha256-normalized-email>`

`GSI1` provides reverse-chronological lists by entity type. Idempotency claims
and unreferenced attachment metadata expire after 24 hours through DynamoDB
TTL. Once an email is accepted, its immutable object reference is copied into
the email payload so a scheduled send does not depend on upload metadata
retention. The table has AWS-managed encryption and point-in-time recovery.

HTML, text, and attachments are externalized into a private, encrypted S3
bucket so DynamoDB's 400 KiB item limit does not constrain normal email
payloads. Direct uploads accept only a caller-declared size and SHA-256, never
an arbitrary remote URL. The bucket denies plaintext transport and objects
expire after 45 days; email metadata remains in DynamoDB. Public email
responses expose attachment metadata only.

## Receive path

Inbound resources are opt-in and isolated from the outbound payload bucket.
When enabled, a public SES Mail Manager ingress accepts IPv4 and IPv6 traffic
for explicitly configured envelope-recipient domain suffixes, up to the
configured size limit. Operators decide whether STARTTLS is optional or
required.

For each accepted message and its matched envelope recipients, the rule first
writes raw MIME to the dedicated S3 bucket and only then invokes Lambda
asynchronously. Both actions drop on configuration failure. The bucket has
versioning, a
customer-managed rotating KMS key, public-access blocking, TLS-only access,
and configurable 1–30 day lifecycle expiry.

The parser validates the provider message ID and raw size, caps MIME nesting
and header size, extracts bodies and at most 50 attachments, and persists
structured objects. A deterministic `RECEIVED#` ID plus a leased
`RECEIVED_CLAIM#` item prevents concurrent repeated invocations from creating
multiple records. The `email.received` webhook carries metadata only.
Authenticated receiving endpoints return parsed content and short-lived S3
links for raw MIME and attachment downloads.

Because Lambda, SQS, and webhooks are at-least-once systems, consumers still
deduplicate webhook events on `data.email_id`. HayaSend never claims
exactly-once notification delivery.

## Webhook signatures

Webhook payloads are signed as:

```text
HMAC-SHA256(secret, "<message-id>.<unix-timestamp>.<raw-json-body>")
```

The base64 signature is sent as `v1,<signature>` in `svix-signature`, together
with `svix-id` and `svix-timestamp`. Consumers must verify the raw body and
reject stale timestamps.

## Known pre-v1 limits

- one bootstrap administrator key per deployment;
- payload retention is fixed at 45 days;
- inbound forwarding, alias routing, and ARC preservation are not implemented;
- no deployment test has run in a dedicated AWS account.
