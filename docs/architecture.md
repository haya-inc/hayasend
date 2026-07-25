# Architecture

## Trust boundary

HayaSend is single-tenant by default. The API, queues, metadata, SES identity,
and delivery events live in the customer's AWS account. There is no Haya
control plane in the data path.

The bootstrap bearer key is passed to Lambda as an encrypted environment
variable by CloudFormation and is intended only for initial administration.
Application keys are stored as SHA-256 hashes with explicit scopes, optional
expiry, and revocation. Moving the bootstrap key into Secrets Manager remains
a pre-v1 hardening item.

## Send path

1. The HTTP API authenticates and validates a Resend-shaped request.
2. DynamoDB claims the idempotency key and stores the email in one transaction.
3. The suppression list is checked before SQS accepts a `send_email` job.
4. The worker reloads current state and rechecks suppressions immediately
   before calling SES v2, so a newly suppressed recipient cannot receive an
   already scheduled message.
5. SES events arrive through SNS and update the record.
6. Matching webhook deliveries return to SQS, so webhook failure cannot cause
   the email to be sent twice.

SQS and Lambda are at-least-once systems. HayaSend therefore treats the email
record as the source of truth and refuses to process a job after the record
reaches a final state. An atomic send lease prevents concurrent workers from
sending the same queued record.

There is still an unavoidable narrow failure window if SES accepts a message
and the worker stops before recording the provider ID. A later retry can
produce a duplicate. HayaSend documents this at-least-once boundary instead
of claiming exactly-once delivery; eliminating it would require provider-side
idempotency that SES does not currently expose.

## Data model

A single DynamoDB table stores typed entities:

- `EMAIL#<id>`
- `DOMAIN#<id>`
- `WEBHOOK#<id>`
- `IDEMPOTENCY#<sha256>`
- `APIKEY#<id>`
- `SUPPRESSION#<sha256-normalized-email>`

`GSI1` provides reverse-chronological lists by entity type. Idempotency claims
expire after 24 hours through DynamoDB TTL. The table has AWS-managed
encryption and point-in-time recovery.

HTML, text, and attachments are externalized into a private, encrypted S3
bucket so DynamoDB's 400 KiB item limit does not constrain normal email
payloads. Objects expire after 45 days; metadata remains in DynamoDB.

## Webhook signatures

Webhook payloads are signed as:

```text
HMAC-SHA256(secret, "<message-id>.<unix-timestamp>.<raw-json-body>")
```

The base64 signature is sent as `v1,<signature>` in `svix-signature`, together
with `svix-id` and `svix-timestamp`. Consumers must verify the raw body and
reject stale timestamps.

## Known pre-v1 limits

- one bootstrap API key per deployment;
- long schedules use repeated SQS delays;
- payload retention is fixed at 45 days;
- no inbound path yet;
- no deployment test has run in a dedicated AWS account.
