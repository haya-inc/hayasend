# HayaSend

Resend-compatible, AWS-native email infrastructure that runs in your own AWS
account.

> **Project status: early alpha.** The API and data model will change before
> v1. Do not use it for critical production traffic yet.

HayaSend provides the developer experience of a modern email API while Amazon
SES handles delivery. Email metadata and infrastructure stay under your AWS
account, and HayaSend never logs message bodies.

[Project site](https://haya-inc.github.io/hayasend/) ·
[Compatibility](docs/compatibility.md) ·
[Support](SUPPORT.md)

## What works today

- `POST /emails` with HTML, text, CC, BCC, reply-to, headers, tags, and
  base64 attachments
- checksum-bound direct S3 attachment uploads up to 25 MiB
- `POST /emails/batch` for up to 100 messages
- hosted templates with unique aliases, typed variables, isolated
  draft/published versions, official SDK/React Email support, and
  repository-to-draft CLI reconciliation with no-send rendering, immutable
  publication history, and restore-to-draft recovery
- 24-hour idempotency using the `Idempotency-Key` header
- hashed, scoped API keys with expiry and revocation
- automatic hard-bounce and complaint suppressions plus manual suppression API
- ISO 8601 and relative scheduling such as `in 10 minutes`, with
  EventBridge Scheduler for delays beyond 15 minutes
- email retrieval, listing, cancellation, and rescheduling
- SES domain creation, DKIM record discovery, refresh, and deletion
- signed webhooks with SQS retry, retained delivery history, manual replay,
  and a dead-letter queue
- SES delivery, delay, bounce, complaint, open, click, and failure events
- opt-in SES Mail Manager receiving with KMS-encrypted raw MIME storage,
  deterministic duplicate suppression, `email.received` webhooks, and
  Resend-shaped content, attachment retrieval, and SDK-assisted forwarding
- local in-memory development mode
- serverless AWS deployment with API Gateway, Lambda, SQS, EventBridge
  Scheduler, SNS, DynamoDB, and SES
- compatibility tests against the official Resend Node, Python, and Go SDKs

See [the compatibility matrix](docs/compatibility.md) for precise coverage.
The dedicated-account deployment gate is documented in
[AWS integration testing](docs/aws-integration-testing.md).

## Use the official Resend SDKs

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

The official Python SDK exposes the same migration path:

```python
import os
import resend

resend.api_key = os.environ["HAYASEND_API_KEY"]
resend.api_url = os.environ["HAYASEND_BASE_URL"]

email = resend.Emails.send(
    {
        "from": "Product <hello@example.com>",
        "to": ["person@example.net"],
        "subject": "Welcome",
        "text": "Your account is ready.",
    }
)
```

The official Go SDK reads its compatible endpoint when the process starts:

```bash
export RESEND_BASE_URL="$HAYASEND_BASE_URL"
export RESEND_API_KEY="$HAYASEND_API_KEY"
```

```go
import (
    "os"

    "github.com/resend/resend-go/v3"
)

email := resend.NewClient(os.Getenv("RESEND_API_KEY"))
sent, err := email.Emails.Send(&resend.SendEmailRequest{
    From:    "Product <hello@example.com>",
    To:      []string{"person@example.net"},
    Subject: "Welcome",
    Text:    "Your account is ready.",
})
```

HayaSend CI verifies the official Go SDK v3.11.0. Treat a returned `err` as a
failed request before reading `sent`.

Hosted templates also work through the official SDK:

```ts
await email.templates
  .create({
    name: "Welcome",
    alias: "welcome",
    from: "Product <hello@example.com>",
    subject: "Welcome, {{{NAME}}}",
    html: "<p>Your account is ready, {{{NAME}}}.</p>",
    variables: [{ key: "NAME", type: "string" }],
  })
  .publish();

await email.emails.send({
  to: "person@example.net",
  template: { id: "welcome", variables: { NAME: "Ada" } },
});
```

See [hosted templates](docs/hosted-templates.md) for React Email, versioning,
variable safety, limits, and least-privilege scopes.

## Run locally

With Docker, the API starts in hardened, read-only local mode:

```bash
docker compose up --build
```

Open [http://localhost:8787/preview](http://localhost:8787/preview) to inspect
every local send as rendered HTML, plain text, or JSON. The preview blocks
remote content and email interactions; it is never registered in AWS mode.

The image runs as the unprivileged `node` user with all Linux capabilities
dropped and binds only to `127.0.0.1:8787`. To run it directly:

```bash
docker build -t hayasend:local .
docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8787:8787 \
  hayasend:local
```

For source development:

Requirements:

- Node.js 22 or newer
- npm 10 or newer

```bash
npm install
npm run dev
```

The local server listens on `http://localhost:8787` and uses the development
key `re_hayasend_dev`. Source development binds to `127.0.0.1` by default.
If you deliberately change `HAYASEND_HOST`, remember that the preview contains
message bodies and must not be exposed to an untrusted network.

To add a pinned local setup to another application without overwriting its
files, run this from a HayaSend checkout:

```bash
npm run cli -- init --dir ../my-application
docker compose -f ../my-application/compose.hayasend.yaml up -d
npm run cli -- doctor
```

The command creates a hardened Compose file and `.env.hayasend.example`. Use
`npm run cli -- help` for the full command list and read
[the CLI guide](docs/cli.md) for secret handling, template-as-code
reconciliation, and real-send behavior. The compiled package exposes the same
commands through its `hayasend` executable.

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

## Releases and verification

Tagged releases publish a multi-platform image to
`ghcr.io/haya-inc/hayasend`, along with a source archive, the OpenAPI contract,
the AWS SAM template, a CycloneDX SBOM, checksums, and signed build provenance.
After the first release, run an exact version rather than a floating tag:

```bash
docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/haya-inc/hayasend:0.1.0
```

Verify that the image was built by this repository before deploying it:

```bash
gh attestation verify \
  oci://ghcr.io/haya-inc/hayasend:0.1.0 \
  --repo haya-inc/hayasend
```

See [the release process](docs/releases.md) for published artifacts,
verification, and maintainer instructions.

## Upload larger attachments

Inline base64 remains compatible with the Resend SDK. For larger files, use
HayaSend's direct-upload extension so the bytes do not pass through API
Gateway:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const content = await readFile("./invoice.pdf");
const checksum = createHash("sha256").update(content).digest("hex");
const upload = await fetch(`${process.env.HAYASEND_BASE_URL}/attachments`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.HAYASEND_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    filename: "invoice.pdf",
    content_type: "application/pdf",
    size_bytes: content.byteLength,
    checksum_sha256: checksum,
  }),
}).then((response) => response.json());

await fetch(upload.upload_url, {
  method: upload.upload_method,
  headers: upload.upload_headers,
  body: content,
});

await fetch(`${process.env.HAYASEND_BASE_URL}/emails`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.HAYASEND_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    from: "Product <hello@example.com>",
    to: "person@example.net",
    subject: "Your invoice",
    text: "The invoice is attached.",
    attachments: [{ attachment_id: upload.id }],
  }),
});
```

The PUT URL expires after 15 minutes and the uploaded object must be referenced
within 24 hours. HayaSend checks both byte length and SHA-256 before accepting
the email, then verifies the downloaded bytes again before SES delivery. The
aggregate decoded attachment limit is 25 MiB, leaving room for MIME expansion
under SES's 40 MB message limit.

## Deploy to AWS

Requirements:

- AWS CLI credentials
- AWS SAM CLI
- an SES-enabled AWS Region
- SES production access before sending to unverified recipients

Start with the non-mutating deployment plan. The explicit account ID prevents
an authenticated shell from silently targeting the wrong account:

```bash
aws_account_id="$(aws sts get-caller-identity --query Account --output text)"
npm run cli -- deploy aws \
  --account "$aws_account_id" \
  --region ap-northeast-1 \
  --stack hayasend
```

The plan validates the tools and template, performs a clean temporary SAM
build, reports SES production access and sending quota, and renders every
parameter and tag. It does not upload artifacts, create a change set, or alter
AWS. After reviewing it, repeat the command with `--apply`:

```bash
npm run cli -- deploy aws \
  --account "$aws_account_id" \
  --region ap-northeast-1 \
  --stack hayasend \
  --apply
```

Apply creates but does not immediately execute a CloudFormation change set.
HayaSend retrieves the exact new change-set ARN, prints its resource changes,
and refuses removals, indeterminate actions, or possible replacements unless
`--allow-destructive-changes` is also present. It never changes DNS. See the
[CLI guide](docs/cli.md#plan-and-deploy-to-aws) for inbound options, parameter
preservation, failure recovery, and output privacy.

Before choosing a Region or comparing hosted alternatives, review the
[reproducible AWS cost model](docs/aws-costs.md). It separates SES charges
from HayaSend infrastructure, shows list price and recurring free allowances
for 10,000 and 1,000,000 monthly messages in Virginia and Tokyo, and includes
a CLI for substituting your own traffic assumptions.

The underlying manual SAM workflow remains supported:

```bash
cp samconfig.toml.example samconfig.toml
sam build
sam deploy --guided
```

The stack generates a 48-character bootstrap administrator key in AWS Secrets
Manager. To supply an existing 32-character-or-longer secret instead, set the
optional `BootstrapSecretArn` parameter. The CloudFormation output
`ApiBaseUrl` is the value to use for `HAYASEND_BASE_URL` or the SDK's
`baseUrl` option.

Webhook event payloads and delivery results are retained in encrypted
DynamoDB for seven days by default so operators can inspect and replay them.
Set `WebhookDeliveryRetentionDays` from 1–30 days to match the deployment's
privacy and recovery requirements.

Inbound receiving is deliberately disabled by default. Enable it only after
reading [the inbound receiving guide](docs/inbound-receiving.md). The stack
then returns `InboundMxRecord`; HayaSend never changes DNS automatically. A
deployment must also replace the non-routable
`InboundRecipientSuffixes=@example.invalid` default with its intended
receiving-domain suffix.

Treat the secret value as a bootstrap administrator key. Use it only to create
least-privilege application keys. Retrieve it without copying the secret into
Lambda configuration:

```bash
export HAYASEND_BOOTSTRAP_SECRET_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name hayasend \
    --query 'Stacks[0].Outputs[?OutputKey==`BootstrapSecretArn`].OutputValue' \
    --output text
)"
export HAYASEND_BOOTSTRAP_KEY="$(
  aws secretsmanager get-secret-value \
    --secret-id "$HAYASEND_BOOTSTRAP_SECRET_ARN" \
    --query SecretString \
    --output text
)"

curl "$HAYASEND_BASE_URL/api-keys" \
  -H "Authorization: Bearer $HAYASEND_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production transactional sender",
    "scopes": ["emails:send", "emails:read"]
  }'
```

The returned application token is shown once. HayaSend stores only its
SHA-256 hash. Unset the administrator key from your shell after use:

```bash
unset HAYASEND_BOOTSTRAP_KEY
```

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
  DynamoDB + Scheduler/SQS ----> send worker ----> Amazon SES
                              |
SES events ----> SNS ----> event normalizer
                              |
                         signed webhooks

Internet SMTP ----> Mail Manager ----> KMS-encrypted S3
                         |                    |
                         +----> parser Lambda +----> receiving API
                                      |
                               email.received webhook
```

SQS handles immediate and short-delay jobs. Longer reservations use
self-deleting, one-time EventBridge Scheduler entries that target the same
queue. Canceling or rescheduling an email deletes or replaces its deterministic
schedule.

Read [the architecture notes](docs/architecture.md) for security boundaries
and delivery semantics.

## Security and privacy

- Application logs never include message bodies, addresses, subjects, webhook
  URLs, credentials, or external provider and network error text. Failure
  entries use opaque identifiers, allowlisted operational metadata, and stable
  error categories.
- Local mode is development-only and has no persistence.
- AWS mode stores metadata in DynamoDB and message bodies and attachments in
  a private, encrypted S3 bucket with a 45-day lifecycle.
- Optional inbound mode uses a separate versioned bucket with a
  customer-managed KMS key and configurable 1–30 day retention. Raw MIME and
  extracted attachments are available only through authenticated,
  short-lived download URLs.
- Attachments can use inline base64 or checksum-bound direct uploads. HayaSend
  deliberately rejects remote attachment URLs to avoid server-side request
  forgery.
- Email retrieval returns attachment metadata but never inline content,
  internal object keys, upload tokens, or checksums.
- Webhook requests use timestamped HMAC-SHA256 signatures and Resend-compatible
  `svix-*` headers.
- Webhook history never stores email bodies, attachments, signing secrets, or
  response bodies. Its failure field contains only an HTTP status or stable
  operational category, never an external exception string. Retained event
  metadata can contain addresses and subjects, expires after the configured
  1–30 day window, and is filtered from API reads immediately at expiry while
  DynamoDB completes asynchronous deletion.
- AWS-mode webhook registration and delivery require public HTTPS and reject
  private, loopback, link-local, and reserved IPv4/IPv6 destinations; delivery
  revalidates DNS at connection time and never follows redirects.
- Application keys are scope-limited and stored as hashes; the deployment
  bootstrap key should not be embedded in applications.
- The bootstrap key lives in Secrets Manager and is fetched only by the API
  function when administrator authentication is attempted.
- Permanent bounces and complaints automatically prevent subsequent sends.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Public roadmap

The [v0.1 beta milestone](https://github.com/haya-inc/hayasend/milestone/1)
tracks the evidence required for the first non-critical evaluation release.
Accepted follow-on work carries the
[`roadmap` label](https://github.com/haya-inc/hayasend/issues?q=state%3Aopen%20label%3Aroadmap),
and bounded starter tasks carry the
[`good first issue` label](https://github.com/haya-inc/hayasend/issues?q=state%3Aopen%20label%3A%22good%20first%20issue%22).

Roadmap issues describe accepted problems and safety constraints, not promised
delivery dates. Security reports must use the private process in
[SECURITY.md](SECURITY.md), never a public roadmap issue.

## Project and commercial support

HayaSend is Apache-2.0 open source. Haya, Inc. intends to fund development
through optional deployment assistance, migration work, security and
deliverability reviews, operational support, and future managed services.
Self-hosting and community use do not require a commercial agreement.

See [SUPPORT.md](SUPPORT.md) and
[the commercial boundary](docs/commercial.md). The
[project site](https://haya-inc.github.io/hayasend/) provides a concise
overview suitable for technical evaluators.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[GOVERNANCE.md](GOVERNANCE.md) before opening a pull request.

## License and trademarks

Source code is licensed under the [Apache License 2.0](LICENSE).
The license does not grant rights to the Haya or HayaSend names and logos; see
[TRADEMARKS.md](TRADEMARKS.md).

HayaSend is independent software and is not affiliated with or endorsed by
Resend. “Resend” is used only to describe API compatibility.
