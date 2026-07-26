# Provider-neutral delivery model

HayaSend separates provider-neutral delivery truth from the existing
Resend-compatible message response. Dispatchable and locally suppressed
messages persist this contract in both the memory and DynamoDB stores without
changing the public API. Recipient attempts and provider events mutate the same
ledger transactionally.

The source contract is
[`src/core/delivery-model.ts`](../src/core/delivery-model.ts), and
`npm run check:conformance` prevents the published
[`delivery-record.v1.schema.json`](../schemas/delivery-record.v1.schema.json)
from drifting from it.

## Records and identities

| Record | Identity | Mutable fields |
| --- | --- | --- |
| Message | Existing opaque `email_…` ID | Derived aggregate and timestamps |
| Recipient | Random opaque `rcpt_…` ID | Lifecycle, latest attempt, timestamp |
| Attempt | Random opaque `attempt_…` ID | Submission result and completion |
| Provider event | Provider plus provider event ID, or a normalized-event digest | None after append |
| Outbox item | Message, job type, and generation | Lease, attempts, dispatch result |

Recipient and attempt IDs require at least 128 bits of URL-safe opaque input.
The adapter or service that creates them must use a cryptographically secure
generator. It must never derive either ID from an address. Envelope roles are
normalized to `to`, `cc`, or `bcc`, while the address remains a customer data
plane field.

`createOutboxIdentity` is deterministic so a reconciler can publish the same
job after a crash without inventing a second logical operation. Generation
starts at zero and changes only for a deliberately distinct operation.

`createProviderEventIdentity` prefers a privacy-safe opaque provider event ID.
If the provider does not supply one, its adapter must first remove
unrecognized and private fields, canonically encode the normalized event, and
supply the SHA-256 digest. The domain package deliberately does not import a
crypto runtime or accept raw provider payloads.

## Lifecycle meanings

- A message aggregate is derived from recipient records; it cannot replace
  recipient truth.
- An attempt covers one provider submission and one or more recipient IDs.
  `ambiguous` means the provider might have accepted the submission but the
  local result could not be committed.
- Provider events are immutable. `terminal` records the adapter's normalized
  interpretation, while later transition logic must keep complaint and
  suppression outcomes safety-sticky.
- An outbox row is pending when it has no dispatch timestamp. A lease owner and
  expiry appear together. A dispatched row cannot retain a lease.

Timestamps are offset-aware ISO 8601 values. Record schema version, provider
name, provider adapter version, and capability document version are explicit
so migrations and conformance evidence can reject silent drift.

## Transactional outbox implementations

`MemoryStore.commitDelivery` is the executable reference for the atomic
boundary. It copy-on-write stages the existing sendable email, provider-neutral
message, recipients, optional idempotency claim, and exactly one generation-zero
dispatch item, then exposes every record in one state swap. A fault before the
swap exposes none of them; process loss after the swap leaves due work for the
reconciler and does not require a client replay.

`OutboxReconciler` conditionally leases due items, publishes a `send_email` job
whose `job_id` is the outbox identity, and acknowledges dispatch. Queue
acceptance followed by process loss can publish the job again after lease
expiry, but both copies have the same identity. Publication failures release
the item immediately with an allowlisted diagnostic category. Scheduled
messages remain undispatched until `due_at`; the same sweep handles the exact
clock boundary.

The privacy-safe metrics are available due count, active lease count, total
undispatched count, expired-lease count, oldest due age, cumulative publication
failures, and a truncation flag for bounded diagnostic queries. They contain no
address, subject, body, provider response, or queue endpoint.

`DynamoStore.commitDelivery` writes the existing email metadata, provider-neutral
message, every unique envelope recipient, optional idempotency claim,
generation-zero outbox item, and durable backlog counter in one
`TransactWriteItems` call. The public 50-recipient limit keeps the transaction
below DynamoDB's 100-action limit.

Attempt start and completion, local cancellation or suppression, recipient
transitions, message aggregate derivation, and public compatibility status are
also atomic. Each DynamoDB mutation compares the complete expected message,
recipient, attempt, and email entities before replacing them in one
`TransactWriteItems` call. Conflicts reload and re-run the shared pure
transition planner. The memory adapter stages the same plan copy-on-write, and
both adapters run the same generated lifecycle and race contract cases.

Provider events live under a globally unique provider-event key and a
message-scoped sparse index. The immutable conditional put and recipient state
changes share one transaction. A repeated SNS `MessageId` returns the original
event without adding history, while the normalized outward webhook is still
published. Event records contain only IDs, normalized type and timestamps,
terminal interpretation, and an optional allowlisted diagnostic category; raw
payloads, SMTP text, addresses, subjects, bodies, and credentials are excluded.

SES delivery, bounce, complaint, and delay notifications carry exact recipient
addresses which are normalized and resolved to opaque recipient IDs before the
event is stored. SES open and click notifications do not identify one recipient
when the original submission had several recipients. In that case the
immutable event is retained with an empty recipient list and current recipient
state is left unchanged.

Pending and leased items use sparse `GSI1` partitions ordered by due time or
lease expiry. GSI reads identify candidates; a conditional update against the
base table is the concurrency authority because GSI reads are eventually
consistent. A successful queue publish and backlog decrement are acknowledged
in one transaction. A failed publish releases the lease, restores the due
index, and increments a privacy-safe counter in one transaction.

Rescheduling a pending delivery updates the legacy email, provider-neutral
message, outbox due time, and sparse-index sort key in one transaction. If an
old send job was already dispatched, the worker reloads the current schedule
and creates a corrective direct job instead of reviving an acknowledged
outbox row.

The one-minute dispatcher provides bounded recovery. API-created SQS and
EventBridge Scheduler work only wakes reconciliation; it never replaces the
outbox record or directly represents provider submission.

## Privacy boundary

Addresses are allowed only on recipient records in the customer data plane.
Message intent is represented by a digest, diagnostics use a fixed allowlist,
and records have no fields for subjects, bodies, attachments, raw SMTP
responses, stack traces, credentials, or signed URLs. Addresses and content
must never be metric dimensions, public identifiers, or default operator
output.
