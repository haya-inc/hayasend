# Cloudflare Workers runtime

HayaSend includes an experimental Cloudflare Workers substrate. The
provider-neutral core and service layer compile without Node globals, Node
built-ins, AWS SDK imports, or the `nodejs_compat` flag. Cloudflare-specific
D1, R2, and Queues adapters implement the same delivery-ledger and durable
outbox ports used by the AWS and in-memory paths. A Beta Email Sending binding
transport and per-domain Queue event consumer are also implemented and tested.

The Beta proof runtime wires those adapters and exposes `/healthz`,
`/capabilities`, `POST /emails`, `POST /emails/batch`, `GET /emails`, and
`GET /emails/:id`. It must not receive production or critical traffic.
Hosted deployment, rollback, cleanup, and cost evidence remains the release
gate owned by issue #104. See
[Cloudflare Beta deployment](cloudflare-deployment.md).

## Storage and delivery substrate

The D1 migrations in `migrations/` create strict,
foreign-keyed records for messages, recipients, delivery attempts, normalized
provider events, idempotency claims, durable outbox items, and optimistic
ledger revisions. The second migration adds a unique, indexed
provider-message correlation field for Email Sending lifecycle events.

The D1 adapter:

- validates a complete commit before any D1 or R2 mutation;
- limits a commit to 50 recipients before storage access;
- commits the message, recipients, outbox, ledger revision, and idempotency
  claim in one transactional D1 batch;
- uses conditional revision and lease-owner guards for concurrent ledger and
  outbox mutation;
- converges duplicate and out-of-order normalized provider events while
  preserving sticky local cancellation and suppression states; and
- retains only bounded diagnostic categories and aggregate outbox counters.

The R2 adapter:

- externalizes private message bodies and attachment content to HayaSend-owned
  object keys in the operator's R2 bucket;
- checks byte limits before `put`, supplies the expected SHA-256 to R2, and
  verifies checksum metadata after write and before read;
- gives each email-payload commit attempt a unique object key, so a later
  successful retry never reuses an old orphan that a concurrent sweep may
  delete;
- treats same-key/same-digest attachment retries as idempotent and rejects
  different content at an occupied key; and
- deletes only expired, HayaSend-managed objects that are absent from the D1
  reference set. This bounded sweep recovers an object left behind when R2
  accepts a payload but the following D1 transaction fails.

The Queues adapter:

- gives every job a deterministic identity derived from its durable outbox or
  delivery identity;
- rejects payloads above 128,000 bytes and delays above 86,400 seconds before
  the Queue binding is called;
- explicitly acknowledges only successfully handled or irrecoverably invalid
  messages and retries ambiguous application failures;
- records stable error categories instead of exception text; and
- republishes a valid dead-letter envelope with the same identity, acknowledging
  the DLQ message only after the primary Queue accepts it.

Queues remain an at-least-once wake-up mechanism. Duplicate delivery is
expected; D1 idempotency, deterministic job identity, and durable outbox state
remain the source of truth.

## Email Sending provider proof

The binding transport accepts the existing provider-neutral email record,
preflights the 50-recipient, HayaSend-effective 20-attachment, and 5 MiB
total-message boundaries before the durable commit, calls the structured Workers
`SendEmail.send()` API, and retains its returned `messageId`. Documented
provider errors are reduced to `invalid_data`, `provider_rejected`,
`provider_throttled`, `provider_unavailable`, or `provider_error`; raw error
text is never retained or emitted.

The event consumer validates the current Cloudflare event schema and accepts
only the six documented lifecycle types: delivered, deferred, bounced,
failed, rejected, and complained. It resolves `messageId` through the unique
D1 attempt index, uses `eventId` as the immutable provider-event identity, and
correlates the single event recipient through the canonical recipient ledger.
Invalid poison messages are acknowledged, while a legitimate event that
arrives before its accepted attempt is indexed is retried. Duplicate and
out-of-order Queue deliveries therefore converge through the same ledger rules
used by AWS.

Open and click events are not published by the current Cloudflare subscription
contract, and Cloudflare does not document provider-side send idempotency.
Those three capabilities are explicitly `unsupported`; they are not emulated.
The machine-readable
[`cloudflare-email.v1.json`](../conformance/providers/cloudflare-email.v1.json)
keeps the provider maturity at Beta. The local
[`conformance report`](../conformance/reports/cloudflare-email.local.v1.json)
intentionally remains failed only on production deploy/rollback evidence,
which is owned by issue #104, and records the three capability differences as
unsupported.

## Privacy boundary

Private email content and recipient addresses remain in the operator's
Cloudflare account by default: D1 holds the delivery state and R2 holds
externalized content. The adapters do not emit raw provider payloads, message
bodies, recipient addresses, or exception strings as telemetry. Operational
state is limited to counts, timestamps, opaque identifiers, and validated
diagnostic categories. A future deployment must preserve this default and
document any explicitly enabled external telemetry sink.

## Fault and contract evidence

The shared substrate suite runs unchanged against the in-memory store and the
D1/R2 implementation. It covers atomic idempotent commit, single-owner leases,
lease acknowledgement, duplicate and out-of-order lifecycle evidence,
concurrent convergence, sticky suppression, failure release, and private-data
exclusion.

Cloudflare workerd tests additionally inject failure before every staged D1
commit component and the final batch, verify that all delivery rows roll back,
exercise the R2 orphan path, enforce pre-mutation size and recipient limits,
prove deterministic duplicate Queue messages, verify explicit
acknowledgement/retry behavior, and recover both successful and ambiguous DLQ
republication.

Run all portability gates locally:

```bash
npm run check:workers
```

The gate verifies generated Workers types, rejects forbidden dependency paths,
type-checks the core, services, and Cloudflare adapters against Web Worker
APIs, runs the isolated workerd integration suite, and performs a Wrangler
dry-run bundle. Node-specific webhook DNS pinning remains in the Node adapter
and is still injected into the AWS runtime.

The CLI now provides plan-first deploy, upgrade, rollback, cleanup, and doctor
commands with exact account confirmation. The manual integration workflow
must still run in an approved general-purpose test account, use a unique
disposable HayaSend resource namespace, and prove a real official SDK send,
controlled failure, rollback, cleanup, and fail-closed absence checks before
the conformance report can pass. Other test-account resources are preserved.
Local proof remains architectural and fault-test evidence, not a
production-readiness claim.
