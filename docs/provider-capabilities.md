# Provider capabilities and conformance

HayaSend publishes a versioned, machine-readable capability document for every
provider adapter. The document is deployment truth, not a marketing parity
claim. A caller, `doctor`, or conformance runner can inspect the effective
limits and unsupported behavior before accepting a message.

The generated artifacts are:

- [`conformance/runtimes/aws-native.v1.json`](../conformance/runtimes/aws-native.v1.json)
  and
  [`conformance/runtimes/cloudflare-native.v1.json`](../conformance/runtimes/cloudflare-native.v1.json),
  plus
  [`conformance/runtimes/portable-postgres.v1.json`](../conformance/runtimes/portable-postgres.v1.json)
  — runtime-substrate capabilities independent of mail transport;
- [`conformance/providers/aws-ses.v1.json`](../conformance/providers/aws-ses.v1.json)
  — current AWS adapter capabilities;
- [`conformance/providers/cloudflare-email.v1.json`](../conformance/providers/cloudflare-email.v1.json)
  — current Beta Cloudflare Email Sending adapter capabilities;
- [`conformance/providers/azure-communication-services.v1.json`](../conformance/providers/azure-communication-services.v1.json)
  — experimental ACS Email transport and Event Grid capabilities;
- [`conformance/providers/sendgrid.v1.json`](../conformance/providers/sendgrid.v1.json)
  — experimental shared SendGrid Mail Send and Signed Event Webhook capabilities;
- [`conformance/deployments/aws-ses.v1.json`](../conformance/deployments/aws-ses.v1.json)
  and
  [`conformance/deployments/cloudflare-email.v1.json`](../conformance/deployments/cloudflare-email.v1.json)
  — exact runtime+transport maturity, effective limits, and evidence gates;
- the five `*-sendgrid.v1.json` documents under
  [`conformance/deployments/`](../conformance/deployments/)
  — Cloud Run, Render, Railway, Fly.io, and Vercel combined readiness gates;
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
deploy, upgrade, rollback, and cleanup evidence. The
[exact-main isolated restore run](https://github.com/haya-inc/hayasend/actions/runs/30350436333)
proves combined D1 and R2 backup/restore, integrity, deterministic one-time
recovery without an external send, cleanup, and zero named residue. The report
therefore passes every required case while retaining the three documented
provider capability gaps as unsupported. The combined deployment remains
non-production because issue #122 still owns terminal event convergence and
controlled mailbox receipt.

## Azure Communication Services Email evidence

The Azure document was checked on 2026-07-29 against the official
[JavaScript Email SDK](https://learn.microsoft.com/en-us/javascript/api/@azure/communication-email/),
[service limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits),
[Event Grid event schema](https://learn.microsoft.com/en-us/azure/event-grid/communication-services-email-events),
and
[custom-domain workflow](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/add-custom-verified-domains).

HayaSend enforces 50 combined recipients, 20 attachments, a conservative
7,500,000 decoded attachment-byte ceiling, and the 10,000,000-byte serialized
request boundary before the durable delivery commit and again immediately
before submission. The completed long-running send operation supplies the
provider message ID.

The Event Grid endpoint uses a secret independent of the API key and checks
the exact configured Communication Services resource `topic`. Delivery
reports correlate that provider message ID and one exact recipient. Immutable
Event Grid IDs deduplicate retries; sticky recipient transitions prevent late
or out-of-order nonterminal events from undoing a terminal outcome. Views and
clicks are retained without recipient mutation when the documented engagement
schema omits a recipient.

Domain lifecycle is intentionally operator-owned. HayaSend reads the existing
Email Communication Services domain, checks Domain/SPF/DKIM/DKIM2
verification and the ACS link, and never creates, mutates, or deletes Azure
resources or DNS. This adapter remains experimental until a hosted Azure
composition proves quota, terminal delivery, controlled receipt,
backup/restore, rollback, and zero-residue cleanup.

## SendGrid evidence

The SendGrid document was checked on 2026-07-29 against the official
[Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send),
[Event Webhook reference](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event),
[Event Webhook security guide](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features),
and
[domain-authentication API](https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/list-all-authenticated-domains).

HayaSend enforces 1,000 combined recipients, 20 attachments, 20,000,000
decoded attachment bytes, and a request strictly below the documented 30 MB
ceiling before durable commit and immediately before submission. It assigns
one opaque RFC Message-ID correlation value before submission because Mail
Send acceptance has no response body or provider idempotency key.

The Signed Event Webhook ingress verifies ECDSA over the timestamp plus exact
raw bytes before JSON parsing. `sg_event_id` supplies immutable deduplication;
opaque HayaSend custom arguments identify one message and accepted attempt;
and each event's `email` identifies one recipient. Late or duplicate deferred
events cannot undo terminal delivery. Bounce and spam-report events converge
to customer-owned suppressions. Raw provider responses, subjects, bodies,
addresses, and user tags are excluded from stored operational evidence and
custom arguments.

The adapter and its local contract tests are implemented, but every combined
deployment remains experimental and `production_ready: false`. Issues #144,
#146, #148, #150, and #155 own the isolated hosted lifecycle, backup/restore,
terminal-delivery, controlled-receipt, and zero-residue proofs.
