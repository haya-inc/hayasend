# Provider capabilities and conformance

HayaSend publishes a versioned, machine-readable capability document for every
provider adapter. The document is deployment truth, not a marketing parity
claim. A caller, `doctor`, or conformance runner can inspect the effective
limits and unsupported behavior before accepting a message.

The generated artifacts are:

- [`conformance/runtimes/aws-native.v1.json`](../conformance/runtimes/aws-native.v1.json)
  and
  [`conformance/runtimes/cloudflare-native.v1.json`](../conformance/runtimes/cloudflare-native.v1.json)
  — runtime-substrate capabilities independent of mail transport;
- [`conformance/providers/aws-ses.v1.json`](../conformance/providers/aws-ses.v1.json)
  — current AWS adapter capabilities;
- [`conformance/providers/cloudflare-email.v1.json`](../conformance/providers/cloudflare-email.v1.json)
  — current Beta Cloudflare Email Sending adapter capabilities;
- [`conformance/deployments/aws-ses.v1.json`](../conformance/deployments/aws-ses.v1.json)
  and
  [`conformance/deployments/cloudflare-email.v1.json`](../conformance/deployments/cloudflare-email.v1.json)
  — exact runtime+transport maturity, effective limits, and evidence gates;
- [`conformance/readiness.v1.json`](../conformance/readiness.v1.json)
  — generated support/readiness matrix and current evidence blockers;
- [`conformance/reports/cloudflare-email.local.v1.json`](../conformance/reports/cloudflare-email.local.v1.json)
  — shared adapter evidence plus the completed #104 hosted lifecycle proof;
- [`conformance/cases.v1.json`](../conformance/cases.v1.json) — shared fault
  and lifecycle cases;
- [`schemas/provider-capabilities.v1.schema.json`](../schemas/provider-capabilities.v1.schema.json)
  — capability document schema;
- [`schemas/runtime-capabilities.v1.schema.json`](../schemas/runtime-capabilities.v1.schema.json)
  — runtime-substrate capability schema;
- [`schemas/deployment-capabilities.v1.schema.json`](../schemas/deployment-capabilities.v1.schema.json)
  — combined runtime+transport deployment schema;
- [`schemas/readiness-matrix.v1.schema.json`](../schemas/readiness-matrix.v1.schema.json)
  — generated readiness matrix schema;
- [`schemas/conformance-result.v1.schema.json`](../schemas/conformance-result.v1.schema.json)
  — evidence report schema.
- [`schemas/delivery-record.v1.schema.json`](../schemas/delivery-record.v1.schema.json)
  — provider-neutral message, recipient, attempt, event, and outbox records.

`npm run check:conformance` regenerates every artifact in memory and fails if a
committed file is absent or stale. This prevents source types, published JSON,
and CI evidence from drifting apart.

See [runtime and transport portability](runtime-portability.md) for why
runtime, transport, and combined readiness are separate. A deployment
combination cannot claim a maturity above its weakest component, and
`production_ready` additionally requires every named operational evidence gate
to pass.

## Support meanings

- `supported` means the current adapter and HayaSend path implement the
  behavior.
- `conditional` means the behavior has an explicit boundary in `notes`, such
  as cancellation only before provider submission.
- `unsupported` means callers and tests must not assume parity.

A conformance result may report `unsupported` only when the case is optional
and references a matching `unsupported` capability. It cannot use
`unsupported` to hide a failed core invariant.

Every report records the schema version, provider and adapter version,
SHA-256 capability digest, exact case count, result totals, and HTTPS evidence
URL. Results must not contain message bodies, subjects, addresses, provider
credentials, signed URLs, or raw provider errors.

## AWS SES evidence

The AWS document was checked on 2026-07-26 against the official
[SES service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html),
[SES v2 event destination API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_EventDestination.html),
and
[SNS event contents](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html).

SES v2 currently allows 40 MB after base64 encoding and 50 combined To, Cc,
and Bcc recipients. HayaSend advertises its lower effective limits: a 9 MiB
serialized API request, a conservative 39 MiB MIME estimate, 25 MiB decoded
attachments, 20 attachments, 50 recipients, 100 strictly validated batch
items, and schedules no more than 30 days ahead.

The current adapter deduplicates immutable provider events with the SNS
`MessageId`, or with a digest of allowlisted normalized fields when no provider
event ID exists. Provider-side send idempotency remains explicitly unsupported.
SES open and click events do not identify the interacting recipient for a
multi-recipient submission, so HayaSend retains that evidence without guessing
or mutating a recipient.

## Cloudflare Email Sending evidence

The Cloudflare document was checked on 2026-07-27 against the official
[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/),
and
[Queues event schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/).

The effective adapter limits are 50 combined recipients, HayaSend's lower
20-attachment limit (Cloudflare allows 32), and 5 MiB for the complete
ordinary outbound message. A conservative 3,800,000
decoded attachment-byte ceiling leaves room for base64 line wrapping and MIME
part overhead. HayaSend applies this provider preflight before the atomic
delivery commit.

The binding's returned `messageId` is indexed against exactly one accepted
attempt. Each per-domain event contributes its `eventId`, `messageId`, one
recipient, terminal marker, and privacy-safe diagnostic category to the
canonical ledger. Subject text, SMTP response text, provider exception text,
and other unrecognized fields are discarded.

The current subscription publishes delivered, deferred, bounced, failed,
rejected, and complained events. Open, click, and durable provider-side send
idempotency are explicitly unsupported. Issue #104 supplies exact-main hosted
deploy, upgrade, rollback, and cleanup evidence. The report now fails only the
new required backup/restore drill because a complete isolated D1 and R2 restore
has not been published; the three documented provider capability gaps remain
unsupported. The combined deployment also remains non-production because
issue #122 still owns terminal event convergence and controlled mailbox
receipt.
