# Inbound alias routing design

Status: **Proposed — no runtime routing may ship before maintainer approval**

Issue: [#26](https://github.com/haya-inc/hayasend/issues/26)

Last standards and AWS documentation review: 2026-07-26

## Decision summary

HayaSend will add automatic inbound alias routing in stages. The first
send-capable stage will not pretend to be a transparent SMTP relay. It will
originate a new, DKIM-signed message from an operator-owned HayaSend identity
and attach the unmodified received message as `message/rfc822`. This is called
`attached` mode.

The original `From`, SPF, DKIM, DMARC, `Return-Path`, `Authentication-Results`,
and ARC fields will not be copied into the outer message. They remain available
inside the attached original message. This makes the outer message's
authentication claims truthful and prevents HayaSend from impersonating the
original author.

Every route is deny-by-default and requires all of the following before it can
become active:

1. an exact inbound domain whose control has been verified;
2. an exact local address or an explicitly approved domain catch-all;
3. one or more separately verified destination mailboxes;
4. a verified HayaSend sending identity for the outer message;
5. a graph check that proves the configuration contains no route cycle;
6. an optimistic configuration revision supplied with activation.

Evaluation is deterministic and can run in dry-run mode without reading raw
MIME or sending mail. Runtime routing remains out of scope until this proposal
is approved.

## Why this boundary

Forwarding is an indirect email flow. Retransmitting with the original envelope
sender normally breaks SPF; changing the envelope sender normally breaks SPF
alignment with an unchanged author address. Content changes can invalidate
DKIM. The current DMARC standard, [RFC 9989](https://www.rfc-editor.org/info/rfc9989/),
therefore cannot make a transparent-forwarding guarantee merely because one
authentication mechanism passed at HayaSend's ingress. RFC 9989 obsoletes RFCs
7489 and 9091 and explicitly retains the interoperability caveat for indirect
mail flows.

[ARC](https://www.rfc-editor.org/info/rfc8617/) can carry an authenticated
chain of custody, but an ARC pass says which handlers made which assessments;
it does not say that the message is safe or that every sealer is trustworthy.
ARC validation can also require multiple DNS lookups and is vulnerable to
replay and resource-amplification pressure. HayaSend must not claim ARC
preservation until it has a complete validator, trust policy, sealer, key
rotation, and adversarial test evidence.

Amazon SES can DKIM-sign an operator-owned identity and use a custom MAIL FROM
domain, but HayaSend's current SES API transport does not provide a
per-original-sender Sender Rewriting Scheme (SRS) relay. SES also replaces
outgoing `Date` and `Message-ID` values. The first version therefore
re-originates a truthful outer message instead of advertising transparent
relay semantics that the transport cannot provide.

## Goals

- Route only mail accepted for an operator-controlled envelope recipient.
- Verify every external destination before it can receive forwarded content.
- Prevent open-relay behavior, cross-tenant access, wildcard escalation,
  trivial loops, repeated delivery, and fan-out amplification.
- Retain the exact original MIME inside the operator's AWS account and preserve
  it byte-for-byte when attached to an authorized forwarded message.
- Make authentication and malware decisions explicit, inspectable, and
  fail-closed where evidence is missing or contradictory.
- Keep route evaluation separate from delivery so operators can use a
  no-send dry run before DNS or route activation.
- Reuse HayaSend's queue, send lease, suppressions, SES event normalization,
  alarms, and bounded retention instead of creating an unobserved mail path.
- Provide deterministic audit evidence without logging subjects, addresses,
  bodies, attachment names, raw headers, or credentials.

## Non-goals

- A general SMTP relay, mailing-list manager, mailbox, autoresponder, or bounce
  generator.
- Preserving the original author's DMARC result on a newly originated outer
  message.
- Sending as an unverified original author.
- SRS, ARC sealing, or an ARC-based DMARC override in the first send-capable
  stage.
- Rewriting or sanitizing original HTML for inline display.
- Routing based on the untrusted MIME `To`, `Cc`, `Bcc`, `Delivered-To`, or
  `Received` fields.
- Automatically changing DNS, SES production access, account quotas, or
  suppression configuration.
- Multi-tenant control-plane behavior. The data model nevertheless includes a
  deployment boundary so a future multi-tenant service cannot accidentally
  share routes.

## Terms and trust boundaries

- **Envelope recipient**: an address from the SES receipt event's
  `receipt.recipients`. This is the only recipient input used for route
  matching. MIME recipient headers are presentation data.
- **Inbound domain**: a domain approved for route creation after DNS proof and
  deployment-suffix checks.
- **Route source**: an exact local address, or an explicit catch-all selector,
  on one inbound domain.
- **Destination**: a terminal external mailbox or another exact local route.
- **Routing identity**: a verified SES identity controlled by the operator and
  used as the outer `From`.
- **Deployment boundary**: a random, non-secret identifier generated per
  HayaSend stack. It is not an AWS account ID and is included in every data key
  and signed trace.
- **Trace key**: a KMS-backed secret used only to authenticate HayaSend routing
  trace values. It is distinct from webhook and API-key material.
- **Hold**: retain the received message and expose a metadata-only operator
  event, but do not send or bounce it.
- **Drop**: make no forwarding attempt. Drops are reserved for an explicit
  operator policy after retention and audit behavior have been reviewed.

The public SMTP ingress and all raw message fields are untrusted. SES verdicts
are trusted only as the assessment made by the configured ingress service.
They are inputs to local policy, not proof that content is benign.

## Canonical address rules

The route configuration grammar intentionally accepts less than SMTP:

- domains are lower-case ASCII IDNA A-labels, without a trailing dot;
- local parts are 1–64 characters, lower-case ASCII dot-atoms;
- quoted local parts, comments, source routes, address literals, UTF-8 local
  parts, control characters, and whitespace are rejected;
- the complete address is at most 254 characters;
- an exact route is stored as `<local>@<domain>`;
- a catch-all is stored as `*@<domain>` and is never inferred from a missing
  exact route;
- destination addresses use the same canonical form.

HayaSend defines lower-case local-part matching as a product contract even
though SMTP transports can technically treat local parts as case-sensitive.
The receiving guide must require operators to use domains where this contract
is acceptable.

## Proposed resource model

The examples describe the contract, not an implemented API.

### Inbound domain

```json
{
  "id": "ird_0123456789abcdef0123456789abcdef",
  "deployment_id": "dep_b0c7f...",
  "domain": "inbound.example.com",
  "recipient_suffix": "@inbound.example.com",
  "ownership_status": "verified",
  "ownership_method": "dns_txt",
  "challenge_name": "_hayasend-route.inbound.example.com",
  "challenge_digest": "sha256:...",
  "mx_status": "observed",
  "catch_all_allowed": false,
  "revision": 4,
  "created_at": "2026-07-26T00:00:00.000Z",
  "verified_at": "2026-07-26T00:05:00.000Z"
}
```

The plaintext challenge token is returned once and never stored. The stored
digest is bound to the deployment ID, domain, and a random 256-bit token. DNS
verification requires the exact TXT value and a domain already covered by
`InboundRecipientSuffixes`. Observing the expected MX target is reported
separately because publishing MX is not sufficient proof of route ownership
and HayaSend does not edit DNS.

DNS verification expires after 30 days if no route is activated. Active
domains are rechecked daily and before a paused route is reactivated. DNS
failure pauses new forwarding after a bounded grace period; it does not delete
mail or route state.

### Destination

```json
{
  "id": "irdst_0123456789abcdef0123456789abcdef",
  "deployment_id": "dep_b0c7f...",
  "address_ciphertext": "kms:...",
  "address_fingerprint": "hmac-sha256:...",
  "status": "verified",
  "verification_method": "email_challenge",
  "verified_at": "2026-07-26T00:10:00.000Z",
  "last_delivery_at": null,
  "suppressed_at": null,
  "revision": 2
}
```

An external destination is terminal and must be verified before route
activation. A verification message:

- contains no received-message data;
- is sent only after an authenticated `routes:write` request;
- expires after 30 minutes and can be redeemed once;
- is limited per deployment, destination fingerprint, source IP, and hour;
- uses the operator's verified routing identity;
- reveals only the requesting deployment's public name and confirmation URL;
- cannot activate a route by itself.

A bootstrap administrator may record an out-of-band verification, but the
audit event must include the method and principal. Application keys cannot
delegate a destination they have not been authorized to view.

Addresses are encrypted in DynamoDB with a customer-managed key or protected
by the table's configured encryption boundary. Indexes and logs use a
deployment-keyed HMAC fingerprint, never a plain address.

### Route

```json
{
  "id": "irr_0123456789abcdef0123456789abcdef",
  "deployment_id": "dep_b0c7f...",
  "source": "support@inbound.example.com",
  "match": "exact",
  "destination_ids": ["irdst_0123456789abcdef0123456789abcdef"],
  "routing_identity": "HayaSend Support <forwarder@notify.example.com>",
  "mode": "attached",
  "auth_policy": "balanced",
  "allow_automated": false,
  "max_message_bytes": 26214400,
  "status": "active",
  "revision": 7,
  "created_at": "2026-07-26T00:12:00.000Z",
  "activated_at": "2026-07-26T00:15:00.000Z"
}
```

Initial limits:

- at most 500 routes per deployment;
- at most 5 destinations per route;
- at most 3 internal route hops;
- one separately queued SES message per external destination;
- at most 25 MiB of original raw MIME before wrapping;
- an exact encoded-size preflight below the SES 40 MB message limit;
- at most 10 received messages per minute per route and 100 per minute per
  deployment by default, with explicit operator configuration for increases.

The rate defaults are conservative product limits, not claims about AWS
service quotas.

## Authorization and ownership

Two new scopes are proposed:

- `routes:read`: list routes, redacted destinations, evaluation results, and
  delivery state;
- `routes:write`: create drafts, request destination verification, pause, and
  propose activation.

Only the bootstrap principal can:

- enable catch-all routing for a domain;
- select `observe` authentication policy;
- accept an out-of-band destination verification;
- increase fan-out, message-size, or rate limits;
- activate the first route on a domain;
- change the routing identity.

A principal cannot issue an API key with scopes it does not hold. Route,
domain, destination, evaluation, and delivery records are always partitioned
by deployment ID. Every lookup supplies that partition key; opaque object IDs
alone are insufficient authorization.

## Routing identity readiness

Route activation does not accept an address merely because SES has seen it.
The selected routing identity must satisfy all of these checks in the deployed
Region:

- `VerifiedForSendingStatus` is true;
- DKIM signing is enabled and its verification status is successful;
- the outer `From` address is within that verified identity;
- a custom MAIL FROM subdomain is configured and its status is successful;
- the custom MAIL FROM subdomain is not an inbound receiving domain;
- MAIL FROM failure behavior is `REJECT_MESSAGE`, so SES does not silently
  fall back to an `amazonses.com` envelope sender;
- the HayaSend configuration set is selected so bounce, complaint, delay,
  delivery, and failure events are correlated with the route delivery.

Activation stores only the identity name and observed readiness state in its
snapshot. It does not copy DKIM private material. The worker rechecks the
identity after a readiness-cache expiry, and SES failure pauses delivery rather
than falling back to a different identity. Identity loss never causes HayaSend
to send as the original author.

## Route lifecycle

```text
draft
  |
  +-- destination or domain incomplete --> pending_verification
  |
  +-- verified + graph safe + revision match --> active
                                                  |
                  operator / DNS / abuse / bounce +--> paused
                                                  |      |
                                                  |      +--> active
                                                  |
                                                  +--> deleted (tombstone)
```

Creation never activates a route. Activation uses `If-Match` with the exact
route revision and a transaction that:

1. rereads the inbound domain, destinations, routing identity, and limits;
2. confirms every referenced resource is verified and in the same deployment;
3. expands local route edges and proves the complete active graph is acyclic;
4. rejects overlapping exact/catch-all ambiguity;
5. stores an immutable configuration snapshot and increments the revision;
6. emits `inbound.route.activated`.

Deletion creates a bounded tombstone so a stale queue item cannot reinterpret
the same ID. Already accepted delivery jobs retain their immutable route
snapshot; pause or deletion prevents unsent jobs from acquiring a send lease.

## Matching and dry-run evaluation

Matching uses only canonical SES envelope recipients:

1. reject an event with no `receipt.recipients`;
2. reject recipients outside verified inbound domains;
3. prefer one exact active route;
4. otherwise use one explicitly active catch-all;
5. otherwise retain without forwarding and return `no_route`;
6. evaluate each matched route against message and authentication policy;
7. expand internal routes, with cycle and hop checks at each edge;
8. create one terminal decision per unique verified destination fingerprint.

Duplicate envelope recipients and destinations collapse deterministically.
No rule can create two terminal decisions for the same received message and
destination.

Proposed dry-run endpoint:

```http
POST /inbound/routes/evaluate
Authorization: Bearer <routes:read key>
Content-Type: application/json

{
  "recipients": ["support@inbound.example.com"],
  "message_bytes": 1048576,
  "auth": {
    "spam": "PASS",
    "virus": "PASS",
    "spf": "PASS",
    "dkim": "PASS",
    "dmarc": "PASS",
    "arc": "none"
  },
  "automated": false,
  "signed_hop_count": 0
}
```

The evaluator accepts facts, not raw MIME, HTML, headers, attachments, or an
S3 object key. It returns route IDs, redacted destination IDs, immutable
configuration revisions, and decisions such as:

- `would_forward`;
- `no_route`;
- `domain_unverified`;
- `destination_unverified`;
- `route_paused`;
- `authentication_hold`;
- `malware_hold`;
- `automated_hold`;
- `loop_detected`;
- `trace_invalid`;
- `message_too_large`;
- `rate_limited`;
- `suppressed`.

Dry-run never claims a delivery, mutates a route, consumes a rate token, reads
received content, or calls SES. The same pure evaluator must be used by the
runtime path, with runtime adapters supplying persisted facts.

## Authentication policy

HayaSend must persist the SES receipt verdicts with the received record. The
raw S3 message's `Authentication-Results` header is useful evidence but is not
parsed as authoritative route input because arbitrary senders can add fields
with that name and because trust depends on the receiving ADMD.

All policies hold when:

- `virus` is `FAIL`, `GRAY`, missing, or `PROCESSING_FAILED`;
- `spam` is `FAIL` or `PROCESSING_FAILED`;
- the provider event or raw object is missing;
- the MIME parser reports a structural or size failure.

The initial policies are:

| Policy | Eligible authentication |
|---|---|
| `strict` | DMARC `PASS`; a future trusted ARC override is not implied |
| `balanced` | DMARC `PASS`, or DMARC `GRAY` with SPF or DKIM `PASS`; DMARC `FAIL` holds |
| `observe` | Authentication failure is audited but only malware, structure, loop, destination, suppression, size, and quota gates block |

`balanced` is the default. `observe` requires bootstrap approval and displays a
prominent warning because a wrapped message can still launder attacker-chosen
content even though its outer sender is truthful.

Authentication pass never bypasses content scanning, ownership, loop,
suppression, rate, or size controls.

## ARC policy

ARC is split into two independent capabilities:

1. **validation** of an incoming chain;
2. **sealing** the message after all HayaSend modifications.

Neither is part of the first send-capable stage. When validation is added:

- accept only one structurally valid chain;
- cap product validation at 10 ARC sets even though RFC 8617 permits up to 50;
- cap DNS queries, per-query time, total time, CNAME depth, and response bytes;
- cache positive and negative DNS responses within their TTL;
- treat any gap, duplicate instance, failed newest seal, malformed set,
  exhausted budget, or DNS error as `arc=fail`;
- treat `arc=fail` exactly like no ARC for authentication eligibility;
- never treat `arc=pass` as a content-safety verdict;
- allow a DMARC local override only for an operator-maintained allowlist of
  trusted sealing domains and selectors;
- record which trusted sealer caused the override without storing the full
  ARC chain in an audit event.

When sealing is added, HayaSend needs a separate domain, selector, KMS-backed
private key, public-key rotation overlap, canonicalization tests, and a raw
transport that applies all message modifications before generating the ARC
set. SES's DKIM signature is not an ARC seal.

In `attached` mode the original chain remains inside the `.eml` attachment.
No original ARC field is copied to the outer message, and the outer message
does not claim that the original chain remains actionable.

## SPF, DKIM, DMARC, and SRS behavior

| Mechanism | Incoming evidence | Outer forwarded message |
|---|---|---|
| SPF | Persist SES verdict and envelope source | SES/custom MAIL FROM for the routing identity; no original SPF claim |
| DKIM | Preserve original signature inside attached MIME | SES signs the verified routing identity |
| DMARC | Evaluate the SES ingress verdict under route policy | Alignment belongs only to the routing identity |
| SRS | Not parsed or generated | Not implemented; the outer message is newly originated |
| ARC | Preserve bytes inside attached MIME; no override initially | No ARC seal initially |

Transparent forwarding or an unchanged outer `From` cannot be added as a
configuration toggle. It requires a new approved proposal proving SRS/VERP
behavior, raw-message canonicalization, ARC policy, bounce routing, abuse
limits, and SES transport capability.

## Message transformation

Each external destination receives a separate outer message:

- `From`: configured, verified routing identity;
- `To`: that one verified destination;
- `Reply-To`: omitted by default; an optional single, syntactically valid
  original reply address may be enabled only after display-name and
  autoresponder risks are documented;
- `Subject`: `[Forwarded for <local alias>] <bounded original subject>`;
- `Date` and `Message-ID`: generated or replaced by SES;
- `Auto-Submitted`: `auto-generated`;
- `X-HayaSend-Trace`: a versioned, signed, opaque trace described below;
- `X-HayaSend-Original-Message-ID`: a bounded copy only when it is syntactically
  valid; it is presentation metadata, not a deduplication authority;
- text body: a short notice naming the local alias, receive time, and
  authentication disposition;
- attachment: the exact original raw MIME as `message/rfc822`.

The outer body does not inline original HTML, remote images, attachments, or
active content. It does not copy `Return-Path`, `Received`,
`Authentication-Results`, `DKIM-Signature`, ARC fields, `Bcc`, SES control
headers, or arbitrary `X-*` headers. The original attachment remains
unmodified.

Before queueing, HayaSend generates the exact MIME representation and verifies
its encoded byte size against both the route limit and SES's current limit.
Oversized messages are held intact; they are never truncated or partially
forwarded.

## Loop and duplicate controls

No single signal is sufficient. HayaSend uses all of these layers:

### Static graph

An active configuration graph must be acyclic. Activation simulates every
exact and catch-all edge, rejects self-destinations, rejects an external
destination that is also an active HayaSend route unless it is represented as
an internal edge, and caps internal expansion at three hops.

### Signed trace

The outer message has one `X-HayaSend-Trace` field containing:

```text
v=1; d=<deployment-id>; m=<opaque-message-key>; h=<hop>; r=<route-token>; t=<unix>; s=<base64url-hmac>
```

The signature covers the canonical field values and destination fingerprint.
It reveals no AWS account ID, address, subject, provider ID, object key, or
secret. Only a valid signature from the current or overlap trace key is
trusted.

- a valid trace for this deployment increments the hop;
- hop greater than 3 is held as `loop_detected`;
- a valid trace for another deployment is treated as external but retained in
  the original attachment;
- a malformed, duplicate, expired, or invalid signature for this deployment
  is held as `trace_invalid`;
- a missing trace is normal internet mail and proceeds through every other
  gate.

Key rotation keeps the previous verification key for longer than the maximum
mail retry and inbound-retention window.

### Delivery claim

The terminal claim key is:

```text
HMAC(deployment, received_id, route_revision, destination_fingerprint, mode)
```

It is written conditionally before queueing and retained for the longer of the
received-message retention and maximum SES retry window. Repeated SES events,
Lambda retries, and webhook replays therefore resolve to the same claim.

### Content fingerprint

HayaSend stores a keyed fingerprint of bounded canonical facts: original
`Message-ID`, envelope source domain, exact raw SHA-256, and received byte
length. It is a secondary loop signal, never a sole identity or authorization
key. A repeat through the same route within retention is held for operator
review.

### Trace headers and automatic mail

Existing `Received` and `Delivered-To` fields are preserved only inside the
original attachment. Their count and values can contribute a warning, but
they are untrusted and do not select a route. HayaSend holds messages with at
least 100 `Received` fields, matching the large loop threshold recommended by
[RFC 5321](https://www.rfc-editor.org/info/rfc5321/).

Messages whose `Auto-Submitted` value is not `no` are held unless the route
has `allow_automated=true`. This follows the loop and amplification concerns
in [RFC 3834](https://www.rfc-editor.org/info/rfc3834/). `Precedence` is only
an audit signal because its semantics are not reliable enough for a hard
decision.

## Suppression, failure, and recovery

Routing reuses HayaSend's outbound queue and configuration set, with route and
destination fingerprints as SES message tags.

Before a send lease:

- check HayaSend's suppression table;
- check destination verification and route status again;
- acquire deployment, route, and destination rate tokens;
- verify the immutable route snapshot;
- verify the raw object version, size, and SHA-256;
- build and size-check the exact outgoing MIME.

Outcome behavior:

| Outcome | Behavior |
|---|---|
| destination already suppressed | do not queue; emit `inbound.forward.suppressed` |
| SES quota/rate response | bounded exponential retry with jitter; no new claim |
| temporary delivery delay | let SES retry; surface metadata-only delayed event |
| permanent bounce | suppress destination, pause all routes that depend only on it, alert operator |
| complaint | suppress destination immediately, pause affected route, alert operator |
| construction or integrity failure | hold, send to routing DLQ, never send partial content |
| exhausted transient retries | mark failed, retain claim, alert operator |
| route paused/deleted before lease | cancel without sending |
| worker crash after SES accepts | preserve current at-least-once caveat; reconcile by provider ID and alert on ambiguity |

HayaSend never generates a bounce to the untrusted original sender after SMTP
acceptance. Doing so could create backscatter. Operator notifications use
signed webhooks and alarms, not message content.

DLQ records contain received ID, route ID, configuration revision, destination
fingerprint, reason code, attempt count, and timestamps. They contain no raw
MIME, subject, address, attachment name, or header value. Redrive uses the
original immutable delivery claim; it cannot create a second logical send.

## Privacy and retention

Raw MIME, parsed bodies, route configuration, destination addresses, and
delivery claims are stored only in the operator's AWS account. Automatic
forwarding necessarily transmits an authorized copy through the operator's
SES account to the verified destination; no Haya control plane receives the
content.

- the original S3 object retains its existing KMS, versioning, TLS-only, and
  lifecycle controls;
- the forwarded `.eml` is streamed or assembled in bounded ephemeral memory
  and is never written to a Haya-owned service;
- destination plaintext is decrypted only in the routing worker;
- application logs and metrics use opaque IDs and reason codes;
- API list responses redact destination addresses unless the caller has
  `routes:read` and requests one route explicitly;
- audit exports use destination fingerprints by default;
- delivery claims and trace fingerprints expire on a documented schedule;
- deleting a route does not silently delete retained received mail;
- decommissioning remains a deliberate operator action for retained buckets
  and KMS keys.

## Audit events

The implementation must emit immutable, metadata-only events for:

- `inbound.domain.challenge_created`;
- `inbound.domain.verified`;
- `inbound.domain.verification_lost`;
- `inbound.destination.challenge_created`;
- `inbound.destination.verified`;
- `inbound.destination.suppressed`;
- `inbound.route.created`;
- `inbound.route.updated`;
- `inbound.route.evaluated`;
- `inbound.route.activated`;
- `inbound.route.paused`;
- `inbound.route.deleted`;
- `inbound.forward.held`;
- `inbound.forward.queued`;
- `inbound.forward.sent`;
- `inbound.forward.delayed`;
- `inbound.forward.bounced`;
- `inbound.forward.complained`;
- `inbound.forward.failed`;
- `inbound.forward.redriven`.

Each event includes actor principal ID, route ID, immutable revision, reason
code, request ID, and time. Delivery events may include received ID,
destination fingerprint, and SES provider ID. They must not include a subject,
address, display name, body, attachment metadata, raw header, challenge token,
API key, object key, or trace signature.

## Adversarial test matrix

The runtime proposal cannot be approved without automated tests covering:

### Ownership and authorization

- route domain outside `InboundRecipientSuffixes`;
- missing, wrong, replayed, expired, and cross-deployment DNS challenges;
- MX observation without TXT ownership proof;
- unverified, suppressed, expired, and cross-deployment destinations;
- application-key scope escalation;
- verified sending identity with disabled or unverified DKIM;
- custom MAIL FROM pending, failed, shared with receiving, or configured to
  use the default value after MX failure;
- catch-all creation without bootstrap approval;
- exact route shadowed by a newly proposed catch-all;
- concurrent activation with a stale revision.

### Routing graph and fan-out

- direct self-loop;
- two-route and three-route cycles;
- cycle introduced through catch-all fallback;
- graph changed between evaluation and activation;
- duplicate destinations reached through multiple internal paths;
- fan-out above five;
- internal hop above three;
- route pause or deletion between queue and send lease.

### Message and trace

- missing trace accepted as ordinary mail;
- valid same-deployment trace increments once;
- wrong key, wrong destination, malformed field, duplicate field, expired
  trace, and excessive hop all hold;
- spoofed `Delivered-To`, `Received`, `Authentication-Results`, ARC, and
  original-recipient headers never select or authorize a route;
- 99 and 100 `Received` fields;
- missing and repeated original `Message-ID`;
- identical SES event delivered concurrently;
- same provider message delivered again after a worker crash;
- content-fingerprint repeat with a new provider ID.

### Authentication and content

- every SES verdict value and missing verdict;
- `balanced`, `strict`, and bootstrap-only `observe`;
- DMARC pass with virus failure still holds;
- ARC-shaped headers without validation do not override DMARC;
- malformed MIME, excessive nesting, excessive headers, and too many
  attachments;
- 25 MiB raw message whose base64 wrapper exceeds the SES limit;
- exact boundary-size success and one-byte-over failure;
- original MIME hash mismatch;
- HTML, executable-looking attachment, embedded message, and hostile filename
  remain inert inside the `.eml` attachment.

### Delivery and recovery

- route, deployment, and destination rate exhaustion;
- HayaSend and SES suppression;
- SES quota throttle and retry jitter;
- hard bounce, complaint, delay, transient failure, and permanent failure;
- DLQ redrive reuses the original delivery claim;
- failure before claim, after claim, after queue, before SES, and after SES
  acceptance;
- no backscatter to forged envelope senders;
- stack deletion and retained inbound data behavior.

### Privacy

- logs, metrics, audit events, DLQ bodies, and dry-run responses contain none
  of the forbidden fields;
- destination encryption and fingerprint partitioning;
- cross-deployment object-ID guessing;
- raw MIME never leaves the operator account except through the explicit SES
  delivery to a verified destination;
- presigned URLs are not created by evaluation or audit paths.

## Delivery stages and approval gates

### Stage 0 — this proposal

- documentation only;
- maintainers approve transformation and abuse boundaries;
- no route endpoint, table entity, IAM permission, or worker is added.

### Stage 1 — configuration and shadow evaluator

- add domain, destination, route, scopes, audit, and pure evaluator;
- all routes remain non-sending;
- run dry evaluations against controlled ingress events;
- publish decision distributions without addresses or content;
- complete an external security review.

Exit evidence: unit/property tests, OpenAPI review, DynamoDB concurrency tests,
least-privilege IAM review, and a dedicated-account no-send integration run.

### Stage 2 — exact routes in `attached` mode

- exact routes only;
- verified destination and routing identity;
- balanced authentication policy;
- signed traces, delivery claims, limits, suppression, DLQ, and alarms;
- account-level feature flag disabled by default.

Exit evidence: adversarial dedicated-account tests, controlled external
mailbox delivery, bounce/complaint exercises, cleanup proof, cost profile, and
operator rollback drill.

### Stage 3 — catch-all

- separate bootstrap approval per domain;
- exact routes still take precedence;
- tighter default rate and fan-out limits;
- abuse monitoring evidence from Stage 2.

### Stage 4 — optional ARC work

- separately approved validation and trust-policy proposal;
- optional sealing only after raw transport and key lifecycle are proven;
- no retroactive claim that Stage 2 preserved authentication.

## Rollback and operator recovery

- The global forwarding feature flag stops new delivery claims.
- Pausing a route stops jobs that have not acquired a send lease.
- Existing received mail remains retrievable under its original retention.
- Destination suppression is never cleared by route rollback.
- Route revisions and tombstones remain long enough to reject stale jobs.
- A trace-key rollback restores the prior key only within its planned overlap;
  operators never copy key material into configuration or logs.
- A failed Stage 2 deployment rolls back code and route activation separately.
  It does not delete the inbound bucket, raw objects, KMS key, audit records,
  suppressions, or delivery claims.
- Ambiguous jobs from the SES acceptance failure window are quarantined for
  operator reconciliation rather than automatically resent.

## Maintainer decisions required

Approval must explicitly answer:

- Is `attached` mode acceptable as the only initial transformation?
- Is `balanced` the right default authentication policy?
- Should destination verification permit bootstrap-recorded out-of-band proof?
- Are five destinations, three internal hops, 25 MiB raw input, and the
  proposed rate defaults conservative enough?
- Should `Reply-To` remain omitted for the initial implementation?
- Is catch-all correctly deferred until exact-route production evidence exists?
- Is ARC correctly separated from the initial send-capable stage?

Approval of this document authorizes only Stage 1. Stage 2 still requires its
own code review and the listed integration evidence.

## Primary references

- [RFC 9989 — DMARC](https://www.rfc-editor.org/info/rfc9989/)
- [RFC 7960 — DMARC and indirect email flows](https://www.rfc-editor.org/info/rfc7960/)
- [RFC 8617 — Authenticated Received Chain](https://www.rfc-editor.org/info/rfc8617/)
- [RFC 8601 — Authentication-Results](https://www.rfc-editor.org/info/rfc8601/)
- [RFC 7208 — SPF](https://www.rfc-editor.org/info/rfc7208/)
- [RFC 6376 — DKIM](https://www.rfc-editor.org/info/rfc6376/)
- [RFC 5321 — SMTP](https://www.rfc-editor.org/info/rfc5321/)
- [RFC 9228 — Delivered-To](https://www.rfc-editor.org/info/rfc9228/)
- [RFC 3834 — automatic responses](https://www.rfc-editor.org/info/rfc3834/)
- [SES receiving concepts](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html)
- [SES receiving notification fields](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html)
- [SES header behavior](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html)
- [SES custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [SES custom MAIL FROM API behavior](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutEmailIdentityMailFromAttributes.html)
- [SES DKIM attributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DkimAttributes.html)
- [SES raw sending](https://docs.aws.amazon.com/ses/latest/dg/send-email-raw.html)
- [SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html)
- [SES account suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
