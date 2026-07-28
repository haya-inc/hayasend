# Runtime and transport portability

HayaSend keeps two infrastructure choices independent:

1. the **runtime substrate** that owns the API, durable delivery state,
   payloads, queue wake-ups, scheduling, secrets, and operations; and
2. the **mail transport** that accepts a message and emits provider lifecycle
   events.

The Resend-shaped application contract and provider-neutral delivery ledger
sit above both choices. Switching either axis must not require application-code
changes or weaken idempotency, recipient truth, recovery, or privacy.

This direction is tracked in
[issue #132](https://github.com/haya-inc/hayasend/issues/132) and refines the
accepted product decision in
[issue #81](https://github.com/haya-inc/hayasend/issues/81).

## Why there are three capability documents

HayaSend publishes independent machine-readable truth for:

- a runtime profile, such as `aws-native` or `cloudflare-native`;
- a transport adapter, such as `aws-ses` or `cloudflare-email`; and
- the exact runtime and transport combination exposed to an operator.

The combined deployment cannot claim a maturity level above its weakest
component. `production_ready: true` additionally requires passed conformance,
lifecycle, terminal-delivery, controlled-receipt, and cleanup evidence.

This prevents a stable runtime from hiding a Beta transport, or a mature
transport from hiding an unproven deployment lifecycle.

## Durable authority

Every runtime profile must preserve these invariants:

- the durable metadata/recipient ledger and transactional outbox are
  authoritative;
- message, recipient, idempotency, and outbox intent commit atomically;
- a queue is an at-least-once wake-up mechanism, never the only record of
  scheduled work;
- a scheduler is a wake-up optimization, never the only record of a due time;
- periodic reconciliation can recover a lost queue or scheduler wake-up;
- long schedules survive queue-retention limits and a process redeploy;
- provider acceptance is distinct from terminal recipient delivery;
- telemetry and evidence omit message content, addresses, credentials, signed
  URLs, and raw provider errors.

The current AWS and Cloudflare implementations already use these semantics.
The portable runtime must reuse them rather than introduce a second delivery
model.

## Runtime profiles

### `aws-native`

The existing AWS profile uses API Gateway/Lambda, DynamoDB, S3, SQS,
EventBridge Scheduler, Secrets Manager, SNS, and CloudWatch. It remains Beta
until the exact-main SES terminal-delivery and controlled-receipt gate in
[issue #126](https://github.com/haya-inc/hayasend/issues/126) passes.

### `cloudflare-native`

The existing Cloudflare profile uses Workers, D1, R2, Queues/DLQ, Cron
Triggers, and an Email Sending event subscription. It remains Beta and
non-production until
[issue #122](https://github.com/haya-inc/hayasend/issues/122) proves a terminal
event and controlled receipt.

### `portable-postgres` (executable foundation)

The shared foundation is one API container and one worker container with:

- PostgreSQL transactions for messages, recipient ledger, attempts, events,
  idempotency claims, and outbox rows;
- database row leases for due work;
- a periodic due-row reconciler;
- optional managed queues as latency accelerators;
- pluggable S3-compatible, Google Cloud Storage, or Azure Blob payload
  storage with checksum-bound direct uploads and final byte-level SHA-256
  verification;
- platform-native environment or mounted-file secret injection plus storage
  workload identity; and
- OpenTelemetry-compatible operational signals.

This single runtime is the intended path to Cloud Run, Azure Container Apps,
Render, Railway, and Fly.io. Each platform gets a deployment pack and exact
operational evidence, not a fork of core delivery logic.

The first thin pack is now published for
[Cloud Run + Cloud SQL + GCS](../deploy/cloud-run/README.md). It uses a Cloud
Run Service, migration Job, and Beta Worker Pool with write-only Terraform
secrets and a migration-first rollout. It remains experimental until its
hosted lifecycle, backup/restore, rollback, cleanup, and exact transport
evidence pass.

The PostgreSQL 18 substrate now implements the complete application `Store`
contract: the delivery ledger and transactional outbox, emails, templates and
immutable publication history, attachments, inbound claims, domains,
webhooks and delivery history, API keys, and suppressions. The executable
runtime adds separate API, migration, and horizontally scalable worker
processes; deterministic durable jobs; `FOR UPDATE SKIP LOCKED` leasing;
expired-lease recovery; retry exhaustion and DLQ-equivalent diagnostics;
periodic outbox reconciliation; readiness checks; graceful lease release; and
bounded retention. Forward-only migrations are serialized with a PostgreSQL
advisory lock and each applied migration is pinned by SHA-256 checksum.

[The portable runtime runbook](portable-postgres.md) documents its exact
settings, storage bindings, identity requirements, and process model. Portable
provider event ingress, backup/restore drills, the remaining platform packs,
and exact hosted evidence remain prerequisites before this profile can be
claimed as a supported Beta deployment.

### `vercel-serverless` (planned experimental)

The Vercel profile is expected to use Functions, Vercel Queues, an external
PostgreSQL authority, object storage, and Cron reconciliation. Vercel Queues
is currently Beta and retains messages for at most 24 hours. HayaSend's
30-day scheduling contract must therefore remain in PostgreSQL and be
materialized into the queue only when work approaches its due time.

The profile remains experimental until duplicate delivery, visibility timeout,
function interruption, deploy interruption, retry exhaustion, long-delay
recovery, terminal provider events, and cleanup all have exact-version
evidence.

## Transport direction

Amazon SES remains the first production candidate. Cloudflare Email Sending
remains Beta. Azure Communication Services Email is the next native transport
candidate because it supplies custom-domain sending and Event Grid delivery
events that can be normalized into the recipient ledger.

Google Cloud does not currently offer a direct SES-equivalent transactional
mail transport. A Cloud Run deployment therefore remains customer-owned in
GCP while using a separately certified external transport adapter. The
application contract and delivery history do not change.

HayaSend does not plan to build or operate a custom MTA.

## Target compositions

| Target | Runtime | Transport | Initial claim |
| --- | --- | --- | --- |
| AWS | `aws-native` | Amazon SES | Beta; production candidate after exact proof |
| Cloudflare | `cloudflare-native` | Cloudflare Email Sending | Beta / non-production |
| Azure | `portable-postgres`, then optional native optimizations | ACS Email/Event Grid | Executable foundation; Beta proof pending |
| GCP / Cloud Run | `portable-postgres` | Certified external adapter | Executable foundation; Beta proof pending |
| Render / Railway / Fly.io | `portable-postgres` | Certified external adapter | Executable foundation; Beta proof pending |
| Vercel | `vercel-serverless` | Certified external adapter | Planned experimental proof |

These are roadmap targets, not current support claims. Generated capability
documents are the deployment truth.

## Published artifacts

Runtime documents:

- [`conformance/runtimes/aws-native.v1.json`](../conformance/runtimes/aws-native.v1.json)
- [`conformance/runtimes/cloudflare-native.v1.json`](../conformance/runtimes/cloudflare-native.v1.json)
- [`conformance/runtimes/portable-postgres.v1.json`](../conformance/runtimes/portable-postgres.v1.json)

Combined deployment documents:

- [`conformance/deployments/aws-ses.v1.json`](../conformance/deployments/aws-ses.v1.json)
- [`conformance/deployments/cloudflare-email.v1.json`](../conformance/deployments/cloudflare-email.v1.json)

Generated readiness matrix:

- [`conformance/readiness.v1.json`](../conformance/readiness.v1.json)

Schemas:

- [`schemas/runtime-capabilities.v1.schema.json`](../schemas/runtime-capabilities.v1.schema.json)
- [`schemas/deployment-capabilities.v1.schema.json`](../schemas/deployment-capabilities.v1.schema.json)
- [`schemas/readiness-matrix.v1.schema.json`](../schemas/readiness-matrix.v1.schema.json)

`npm run check:conformance` rejects missing or stale generated artifacts.

## Commercial boundary

The data plane, runtime contracts, deployment packs, schemas, and conformance
runner remain Apache-2.0. Paid value can cover certified combinations,
fleet/version/drift management, safe upgrades and rollback, backup/restore
drills, compliance and advanced policy, private migration reviews, and
production support.

A future management plane remains content-blind by default.

## Official references

Checked on 2026-07-28:

- [Azure Communication Services limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits)
- [Azure Communication Services Email events](https://learn.microsoft.com/en-us/azure/event-grid/communication-services-email-events)
- [Google Cloud guidance for sending email](https://docs.cloud.google.com/compute/docs/tutorials/sending-mail)
- [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run)
- [Cloud Tasks with Cloud Run](https://docs.cloud.google.com/run/docs/triggering/using-tasks)
- [Vercel Queues](https://vercel.com/docs/queues)
- [Vercel Queues API and limits](https://vercel.com/docs/queues/api)
- [Render background workers](https://render.com/docs/background-workers)
