# HayaSend

Resend-compatible, AWS-native email infrastructure that runs in your own AWS
account.

> **Project status: early alpha.** The API and data model will change before
> v1. Do not use it for critical production traffic yet.

HayaSend provides the developer experience of a modern email API while Amazon
SES handles delivery. Email metadata and infrastructure stay under your AWS
account, and HayaSend never logs message bodies.

## What works today

- `POST /emails` with HTML, text, CC, BCC, reply-to, headers, tags, and
  base64 attachments
- `POST /emails/batch` for up to 100 messages
- 24-hour idempotency using the `Idempotency-Key` header
- hashed, scoped API keys with expiry and revocation
- automatic hard-bounce and complaint suppressions plus manual suppression API
- ISO 8601 and relative scheduling such as `in 10 minutes`
- email retrieval, listing, cancellation, and rescheduling
- SES domain creation, DKIM record discovery, refresh, and deletion
- signed webhooks with SQS retry and a dead-letter queue
- SES delivery, delay, bounce, complaint, open, click, and failure events
- local in-memory development mode
- serverless AWS deployment with API Gateway, Lambda, SQS, SNS, DynamoDB,
  and SES
- compatibility tests against the official `resend` Node SDK

See [the compatibility matrix](docs/compatibility.md) for precise coverage.

## Use the official Resend SDK

The current official Node SDK accepts a custom `baseUrl`, so no fork is
required:

```ts
import { Resend } from "resend";

const email = new Resend(process.env.HAYASEND_API_KEY, {
  baseUrl: process.env.HAYASEND_BASE_URL,
});

const { data, error } = await email.emails.send({
  from: "Product <hello@example.com>",
  to: "person@example.net",
  subject: "Welcome",
  text: "Your account is ready.",
});
```

Use a key beginning with `re_` for compatibility with clients that validate
the key prefix.

## Run locally

Requirements:

- Node.js 22 or newer
- npm 11 or newer

```bash
npm install
npm run dev
```

The local server listens on `http://localhost:8787` and uses the development
key `re_hayasend_dev`.

```bash
curl http://localhost:8787/emails \
  -H 'Authorization: Bearer re_hayasend_dev' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: welcome-user-42' \
  -d '{
    "from": "Product <hello@example.com>",
    "to": "person@example.net",
    "subject": "Welcome",
    "text": "Your account is ready."
  }'
```

Local mode records metadata in memory and writes only envelope metadata to
stdout. It does not contact SES or deliver real messages.

## Deploy to AWS

Requirements:

- AWS CLI credentials
- AWS SAM CLI
- an SES-enabled AWS Region
- SES production access before sending to unverified recipients

```bash
cp samconfig.toml.example samconfig.toml
sam build
sam deploy --guided
```

Set `ApiKey` to a long, randomly generated `re_`-prefixed secret. The
CloudFormation output `ApiBaseUrl` is the value to use for
`HAYASEND_BASE_URL` or the SDK's `baseUrl` option.

Treat this deployment value as a bootstrap administrator key. Use it once to
create a least-privilege application key:

```bash
curl "$HAYASEND_BASE_URL/api-keys" \
  -H "Authorization: Bearer $HAYASEND_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production transactional sender",
    "scopes": ["emails:send", "emails:read"]
  }'
```

The returned token is shown once. HayaSend stores only its SHA-256 hash.

The stack intentionally retains its DynamoDB table when deleted. The queue
uses a dead-letter queue, DynamoDB has point-in-time recovery, and Lambda uses
AWS X-Ray tracing. Subscribe an operational endpoint to the `AlarmTopicArn`
output and use the generated CloudWatch dashboard. See
[the operations runbook](docs/operations.md).

## Architecture

```text
Application / Resend SDK
          |
      HTTP API
          |
  DynamoDB + SQS ----> send worker ----> Amazon SES
                              |
SES events ----> SNS ----> event normalizer
                              |
                         signed webhooks
```

Long schedules are implemented by safe 15-minute SQS hops until the scheduled
time. A future release will use EventBridge Scheduler for lower cost at long
durations.

Read [the architecture notes](docs/architecture.md) for security boundaries
and delivery semantics.

## Security and privacy

- Message bodies are never written to application logs.
- Local mode is development-only and has no persistence.
- AWS mode stores metadata in DynamoDB and message bodies and attachments in
  a private, encrypted S3 bucket with a 45-day lifecycle.
- Attachments must be supplied as base64. HayaSend deliberately rejects
  remote attachment URLs to avoid server-side request forgery.
- Webhook requests use timestamped HMAC-SHA256 signatures and Resend-compatible
  `svix-*` headers.
- Application keys are scope-limited and stored as hashes; the deployment
  bootstrap key should not be embedded in applications.
- Permanent bounces and complaints automatically prevent subsequent sends.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Project and commercial support

HayaSend is Apache-2.0 open source. Haya, Inc. intends to fund development
through optional deployment assistance, migration work, security and
deliverability reviews, operational support, and future managed services.
Self-hosting and community use do not require a commercial agreement.

See [SUPPORT.md](SUPPORT.md) and
[the commercial boundary](docs/commercial.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[GOVERNANCE.md](GOVERNANCE.md) before opening a pull request.

## License and trademarks

Source code is licensed under the [Apache License 2.0](LICENSE).
The license does not grant rights to the Haya or HayaSend names and logos; see
[TRADEMARKS.md](TRADEMARKS.md).

HayaSend is independent software and is not affiliated with or endorsed by
Resend. “Resend” is used only to describe API compatibility.
