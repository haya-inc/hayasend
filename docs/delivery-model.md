# Provider-neutral delivery model

HayaSend separates provider-neutral delivery truth from the existing
Resend-compatible message response. The first version is a contract only: it
does not change the public API, current stores, or current AWS runtime behavior.
Subsequent Gate 1 work will persist and operate on these records.

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

## Memory outbox reference

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
undispatched count, oldest due age, and cumulative publication failures. They
contain no address, subject, body, provider response, or queue endpoint.

## Privacy boundary

Addresses are allowed only on recipient records in the customer data plane.
Message intent is represented by a digest, diagnostics use a fixed allowlist,
and records have no fields for subjects, bodies, attachments, raw SMTP
responses, stack traces, credentials, or signed URLs. Addresses and content
must never be metric dimensions, public identifiers, or default operator
output.
