# Provider capabilities and conformance

HayaSend publishes a versioned, machine-readable capability document for every
provider adapter. The document is deployment truth, not a marketing parity
claim. A caller, `doctor`, or conformance runner can inspect the effective
limits and unsupported behavior before accepting a message.

The generated artifacts are:

- [`conformance/providers/aws-ses.v1.json`](../conformance/providers/aws-ses.v1.json)
  — current AWS adapter capabilities;
- [`conformance/cases.v1.json`](../conformance/cases.v1.json) — shared fault
  and lifecycle cases;
- [`schemas/provider-capabilities.v1.schema.json`](../schemas/provider-capabilities.v1.schema.json)
  — capability document schema;
- [`schemas/conformance-result.v1.schema.json`](../schemas/conformance-result.v1.schema.json)
  — evidence report schema.
- [`schemas/delivery-record.v1.schema.json`](../schemas/delivery-record.v1.schema.json)
  — provider-neutral message, recipient, attempt, event, and outbox records.

`npm run check:conformance` regenerates every artifact in memory and fails if a
committed file is absent or stale. This prevents source types, published JSON,
and CI evidence from drifting apart.

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
