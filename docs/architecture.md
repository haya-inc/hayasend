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
2. After suppression preflight, DynamoDB atomically stores the email,
   provider-neutral message, unique envelope recipients, optional idempotency
   claim, deterministic outbox item, and backlog counter.
3. A bounded dispatcher conditionally leases due outbox rows and publishes a
   deterministic send job. Immediate SQS and self-deleting EventBridge
   Scheduler resources only wake reconciliation; a failed wake is recovered by
   the one-minute sweep.
4. The send worker reloads current state, rechecks suppressions, and verifies
   attachment size and SHA-256 immediately before calling SES v2, so a newly
   suppressed recipient or corrupted attachment cannot be delivered.
5. Permanent SES request rejections fail immediately. Throttling, provider
   availability, network, timeout, and unknown application failures return to
   SQS for no more than three delivery attempts.
6. SES events arrive through SNS and update the record.
7. Matching webhook deliveries return to SQS, so webhook failure cannot cause
   the email to be sent twice.

SQS and Lambda are at-least-once systems. HayaSend therefore treats the
DynamoDB delivery records and outbox as the source of truth and refuses to
process a job after the email reaches a final state. A conditional outbox lease
coordinates publishers, and an atomic send lease prevents concurrent workers
from submitting the same queued record.

Scheduler names are derived from email IDs. Rescheduling replaces the same
one-time schedule and atomically moves the pending outbox due time,
cancellation deletes the wake-up schedule, and stale SQS deliveries reload the
current DynamoDB record before doing any work.

If persistence succeeds but an SQS or Scheduler wake fails, the API still
returns the committed message and increments `OutboxWakeFailures`. The periodic
dispatcher recovers the due row without a client replay. Queue acceptance
followed by dispatcher process loss may publish the deterministic job again
after lease expiry; the send lease and final-state check collapse concurrent
copies.

There is still an unavoidable narrow failure window if SES accepts a message
and the worker stops before recording the provider ID. A later retry can
produce a duplicate. HayaSend documents this at-least-once boundary instead
of claiming exactly-once delivery; eliminating it would require provider-side
idempotency that SES does not currently expose.

## Data model

A single DynamoDB table stores typed entities:

- `EMAIL#<id>`
- `EMAIL#<id>` / `DELIVERY_MESSAGE#<id>`
- `EMAIL#<id>` / `RECIPIENT#<recipient-id>`
- `OUTBOX#<deterministic-id>`
- `OUTBOX_METRICS`
- `ATTACHMENT#<id>`
- `RECEIVED#<id>`
- `RECEIVED_CLAIM#<id>`
- `DOMAIN#<id>`
- `WEBHOOK#<id>`
- `WEBHOOK_DELIVERY#<id>`
- `IDEMPOTENCY#<sha256>`
- `APIKEY#<id>`
- `SUPPRESSION#<sha256-normalized-email>`
- `TEMPLATE#<id>`
- `TEMPLATE_ALIAS#<alias>`
- `TEMPLATE_PUBLISHED_ALIAS#<alias>`
- `TEMPLATE_VERSION#<template-id>` / `TEMPLATE_VERSION#<version-id>`

`GSI1` provides reverse-chronological lists by entity type. Idempotency claims
and unreferenced attachment metadata expire after 24 hours through DynamoDB
TTL. Once an email is accepted, its immutable object reference is copied into
the email payload so a scheduled send does not depend on upload metadata
retention. The table has AWS-managed encryption and point-in-time recovery.

Webhook delivery records use `GSI1PK=WEBHOOK_DELIVERIES#<webhook-id>` for
reverse-chronological inspection. They retain the exact event metadata needed
for replay plus attempt count, status code, and a stable operational error
category. They never retain an external exception string, email body,
attachment, signing secret, or HTTP response body. The configurable 1–30 day
expiry is enforced on reads as well as by DynamoDB TTL because physical TTL
deletion is asynchronous.

HTML, text, and attachments are externalized into a private, encrypted S3
bucket so DynamoDB's 400 KiB item limit does not constrain normal email
payloads. Direct uploads accept only a caller-declared size and SHA-256, never
an arbitrary remote URL. The bucket denies plaintext transport and objects
expire after 45 days; email metadata remains in DynamoDB. Public email
responses expose attachment metadata only.

Application failure telemetry is deliberately data-minimized. API requests
receive a server-generated request ID; failure logs retain that ID where
applicable, opaque resource or queue identifiers, allowlisted HTTP or job
metadata, aggregate counts, and a stable error category. Addresses, subjects,
webhook URLs, payloads, caller-supplied correlation IDs, and provider or
network exception strings do not enter application logs. Final email and
webhook failure fields use the same categories rather than copying exception
messages.

Templates remain within the DynamoDB size boundary through a 128 KiB
per-version limit. Each template record contains the editable draft and
immutable published snapshot; sends never read draft content. Published
versions are also retained as separate immutable records with a configurable
count and TTL. Publication atomically writes the history item, published
snapshot, and published-alias mapping. Draft aliases are separate, so editing
or restoring a draft cannot redirect production sends. Alias ownership and
revision changes are transactional, and optimistic revision checks reject
concurrent updates. Variables are type checked before queueing and HTML values
are escaped during rendering.

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

In AWS mode, webhook endpoints must use HTTPS and are resolved when registered
and again for each new outbound connection. Every returned IPv4 and IPv6
address must be globally routable. The connection uses only those validated
results and does not follow redirects, preventing a public hostname or
redirect from reaching VPC, loopback, link-local, carrier-grade NAT, or
instance-metadata addresses. Local mode deliberately permits private
endpoints for development.

Webhook payloads are signed as:

```text
HMAC-SHA256(secret, "<message-id>.<unix-timestamp>.<raw-json-body>")
```

The base64 signature is sent as `v1,<signature>` in `svix-signature`, together
with `svix-id` and `svix-timestamp`. Consumers must verify the raw body and
reject stale timestamps.

The message ID is allocated before SQS enqueue and remains stable across
automatic retries, allowing consumers to deduplicate at-least-once delivery.
A manual replay creates a new delivery record and message ID, links it through
`replayed_from`, and preserves the original event and event timestamp.

## Known pre-v1 limits

- one bootstrap administrator key per deployment;
- payload retention is fixed at 45 days;
- template publication history is bounded to 1–50 versions and 1–365 days;
- inbound forwarding, alias routing, and ARC preservation are not implemented;
- no deployment test has run in a dedicated AWS account.
