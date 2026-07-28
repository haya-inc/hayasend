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
- a transport adapter, such as `aws-ses`, `cloudflare-email`, or `sendgrid`;
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
secrets, split workload identities, a migration-first rollout, and an optional
content-free Pub/Sub hint path. PostgreSQL remains authoritative and bounded
polling recovers every lost or unavailable hint. It remains experimental until
its hosted lifecycle, backup/restore, rollback, cleanup, and exact transport
evidence pass.

The second thin pack targets
[Render Web Services, Background Workers, and private PostgreSQL](../deploy/render/README.md).
It pins the same released image for both processes, gates each revision on
the shared migration runner, disables automatic and preview deploys, and
starts with the non-sending console transport and disabled direct-upload
storage. The signed SendGrid combination is enabled only in a separately
approved transport phase. It remains experimental until hosted evidence
passes.

The third thin pack targets
[Railway services, PostgreSQL 18, and private S3-compatible Buckets](../deploy/railway/README.md).
It uses Railway's experimental project-level TypeScript IaC, pins one image
digest across the API and worker, rejects destructive plans, and gives direct
uploads a Railway-native object store. The lifecycle graph defaults to console,
caps each process for the disposable proof, and requires an explicit opt-in
before adding SendGrid credentials. It remains experimental until hosted
lifecycle, backup/restore, rollback, cleanup, and exact-transport evidence
passes. Railway Bucket credentials remain isolated from any scoped SendGrid
credential.

The fourth thin pack targets
[Fly.io process groups, Managed Postgres, and private Tigris storage](../deploy/flyio/README.md).
It uses one immutable image for the migration command, API, and durable
worker, keeps the application stateless, verifies the exact Machine/resource
inventory, defaults lifecycle proofs to the non-sending console transport, and
publishes guarded rollback and cleanup scripts. Fly Managed Postgres currently
tops out at PostgreSQL 17, and `fly storage create` does not enable Tigris
snapshots, so hosted PostgreSQL-version parity and an object-store restore
design remain explicit promotion gates.

The experimental
[Azure Container Apps pack](../deploy/azure-container-apps/README.md) binds the
same API, worker, migration job, and PostgreSQL authority to Container Apps,
private PostgreSQL Flexible Server 18, Blob user-delegation uploads, Key Vault,
managed identity, ACS Email, and secret Event Grid ingress. Its Event Grid
subscription is deliberately managed outside Terraform so the independent
delivery secret is never persisted in Terraform state. Hosted lifecycle and
terminal-recipient evidence remain tracked separately in #152.

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
settings, storage bindings, identity requirements, and process model. ACS
Email and SendGrid now supply authenticated portable provider-event ingress;
backup/restore drills and exact hosted evidence remain prerequisites before
this profile can be claimed as a supported Beta deployment.

### `vercel-serverless` (executable experimental)

The [Vercel pack](../deploy/vercel/README.md) now uses a Hono Function,
Vercel Queues, private Vercel Blob, an external PostgreSQL 18 authority, and
authenticated minute Cron reconciliation. Successful mutations send only a
content-free reconciliation wakeup. Queue and Cron invocations run bounded
worker bursts; PostgreSQL jobs and leases remain authoritative. The first
hosted lifecycle deploy explicitly overrides the project transport to
`console`; SendGrid credentials are not required until the separately approved
terminal-delivery phase.

Vercel Queues is public Beta and now retains messages for at most seven days.
Its idempotency window remains at most 24 hours. HayaSend's 30-day scheduling
contract therefore remains entirely in PostgreSQL, with Cron recovering lost
or expired wakeups. Signed direct Blob uploads avoid the Vercel Function
4.5 MB body limit.

The profile remains experimental until duplicate delivery, visibility timeout,
function interruption, deploy interruption, retry exhaustion, long-delay
recovery, terminal provider events, and cleanup all have exact-version
evidence.

## Transport direction

Amazon SES remains the first production candidate. Cloudflare Email Sending
remains Beta. The experimental Azure Communication Services Email adapter now
implements SDK submission, read-only linked-domain verification, strict
request limits, and authenticated Event Grid delivery/engagement ingress.
Recipient delivery reports converge into the same ledger; engagement events
that omit the recipient are retained without guessing. Hosted terminal
delivery, controlled receipt, quota, rollback, and cleanup evidence still gate
promotion.

Google Cloud does not currently offer a direct SES-equivalent transactional
mail transport. The implemented SendGrid adapter therefore gives Cloud Run,
Render, Railway, Fly.io, and Vercel one shared HTTP transport with
authenticated domains, fail-closed submission limits, signed recipient-level
events, duplicate/out-of-order convergence, and suppression handling. The
application contract and delivery history do not change. Every exact host
combination remains experimental until its hosted evidence gates pass.

HayaSend does not plan to build or operate a custom MTA.

## Target compositions

| Target | Runtime | Transport | Initial claim |
| --- | --- | --- | --- |
| AWS | `aws-native` | Amazon SES | Beta; production candidate after exact proof |
| Cloudflare | `cloudflare-native` | Cloudflare Email Sending | Beta / non-production |
| Azure | `portable-postgres`, then optional native optimizations | ACS Email/Event Grid | Experimental adapter and foundation; hosted proof pending |
| GCP / Cloud Run | `portable-postgres` | SendGrid | Implemented experimental combination; hosted proof pending |
| Render | `portable-postgres` | SendGrid | Implemented experimental combination; hosted proof pending |
| Railway | `portable-postgres` | SendGrid | Implemented experimental combination; hosted proof pending |
| Fly.io | `portable-postgres` | SendGrid | Implemented experimental combination; hosted proof pending |
| Vercel | `vercel-serverless` | SendGrid | Implemented experimental combination; hosted proof pending |

These are roadmap targets, not current support claims. Generated capability
documents are the deployment truth.

## Published artifacts

Runtime documents:

- [`conformance/runtimes/aws-native.v1.json`](../conformance/runtimes/aws-native.v1.json)
- [`conformance/runtimes/cloudflare-native.v1.json`](../conformance/runtimes/cloudflare-native.v1.json)
- [`conformance/runtimes/portable-postgres.v1.json`](../conformance/runtimes/portable-postgres.v1.json)
- [`conformance/runtimes/vercel-serverless.v1.json`](../conformance/runtimes/vercel-serverless.v1.json)

Provider documents:

- [`conformance/providers/aws-ses.v1.json`](../conformance/providers/aws-ses.v1.json)
- [`conformance/providers/cloudflare-email.v1.json`](../conformance/providers/cloudflare-email.v1.json)
- [`conformance/providers/azure-communication-services.v1.json`](../conformance/providers/azure-communication-services.v1.json)
- [`conformance/providers/sendgrid.v1.json`](../conformance/providers/sendgrid.v1.json)

Combined deployment documents:

- [`conformance/deployments/aws-ses.v1.json`](../conformance/deployments/aws-ses.v1.json)
- [`conformance/deployments/cloudflare-email.v1.json`](../conformance/deployments/cloudflare-email.v1.json)
- [`conformance/deployments/cloud-run-sendgrid.v1.json`](../conformance/deployments/cloud-run-sendgrid.v1.json)
- [`conformance/deployments/render-sendgrid.v1.json`](../conformance/deployments/render-sendgrid.v1.json)
- [`conformance/deployments/railway-sendgrid.v1.json`](../conformance/deployments/railway-sendgrid.v1.json)
- [`conformance/deployments/flyio-sendgrid.v1.json`](../conformance/deployments/flyio-sendgrid.v1.json)
- [`conformance/deployments/vercel-sendgrid.v1.json`](../conformance/deployments/vercel-sendgrid.v1.json)

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

Checked on 2026-07-29:

- [Azure Communication Services limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits)
- [Azure Communication Services Email events](https://learn.microsoft.com/en-us/azure/event-grid/communication-services-email-events)
- [Google Cloud guidance for sending email](https://docs.cloud.google.com/compute/docs/tutorials/sending-mail)
- [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run)
- [Pub/Sub pull subscriptions](https://docs.cloud.google.com/pubsub/docs/pull)
- [Vercel Queues](https://vercel.com/docs/queues)
- [Vercel Queues seven-day TTL](https://vercel.com/changelog/queues-now-supports-7-day-ttl)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)
- [Render background workers](https://render.com/docs/background-workers)
- [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
- [Railway Storage Buckets](https://docs.railway.com/storage-buckets)
- [Fly.io app configuration](https://fly.io/docs/reference/configuration/)
- [Fly.io Managed Postgres](https://fly.io/docs/mpg/)
- [Fly.io Tigris object storage](https://fly.io/docs/tigris/)
