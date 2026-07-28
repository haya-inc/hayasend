# Portable PostgreSQL runtime

The portable runtime is the shared durable foundation for Cloud Run, Azure
Container Apps, Render, Railway, Fly.io, and the Vercel serverless adapter. It
is executable, but is not yet a supported Beta deployment: hosted
provider-event, backup/restore, and platform lifecycle proofs remain open.

## Process model

Run the same built artifact as three independently supervised processes:

1. a one-off forward-only migration process;
2. one or more stateless API processes; and
3. one or more durable workers.

All API and worker instances must use the same PostgreSQL database. PostgreSQL
is the authority for application state, recipient truth, the transactional
outbox, schedules, and jobs. A worker periodically reconciles the outbox, so a
lost wake-up or process restart does not require an API client to retry.

```text
API container ── transaction ──> PostgreSQL 18 <── SKIP LOCKED ── worker
      └── optional fixed hint ──> managed wake-up ──────┘
                                      │
                                      └── durable schedule/outbox recovery
```

## Required settings

Set these on the migration, API, and worker processes:

| Variable | Meaning |
| --- | --- |
| `HAYASEND_MODE=portable` | Selects the portable PostgreSQL runtime |
| `HAYASEND_DATABASE_URL` | `postgresql://` connection URL; configure TLS according to the managed database |
| `HAYASEND_API_KEY` | Secret-injected bootstrap key, 16–512 characters and beginning with `re_` |
| `HAYASEND_TRANSPORT` | `aws-ses`, `azure-communication-services`, or `sendgrid` for real submission; `console` for development only |
| `AWS_REGION` | SES Region when `HAYASEND_TRANSPORT=aws-ses` |

`aws-ses` also needs AWS credentials supplied through the AWS SDK credential
chain and optional `HAYASEND_CONFIGURATION_SET`. Cross-cloud identity and
terminal SES event ingress are not yet certified.

The experimental ACS Email adapter uses `DefaultAzureCredential` for both
submission and read-only resource inspection. Set the applicable values when
`HAYASEND_TRANSPORT=azure-communication-services`:

| Variable | Meaning |
| --- | --- |
| `AZURE_COMMUNICATION_EMAIL_ENDPOINT` | HTTPS endpoint of the linked Communication Services resource |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the communication resources |
| `AZURE_RESOURCE_GROUP` | Resource group containing both resources |
| `AZURE_COMMUNICATION_SERVICE_NAME` | Communication Services resource receiving the linked domain |
| `AZURE_EMAIL_SERVICE_NAME` | Email Communication Services resource that owns the domain |
| `AZURE_EMAIL_DOMAIN_RESOURCE_NAME` | Existing Azure domain resource name, such as `AzureManagedDomain` or the custom domain |
| `HAYASEND_AZURE_EVENT_GRID_SECRET` | API process only: independent 32–512 character secret configured as the `x-hayasend-event-grid-secret` Event Grid delivery header |
| `HAYASEND_REGION` or `AZURE_LOCATION` | Public region metadata recorded for HayaSend domains |

`HAYASEND_AZURE_EVENT_GRID_SECRET_FILE` is also supported. Do not reuse the
HayaSend API key or expose this secret to migration and worker processes.
Configure Event Grid to deliver ACS Email events to
`POST /events/azure-email` with that custom header. HayaSend verifies the
secret and the exact configured Communication Services resource ID in every
event `topic`, validates the subscription handshake, limits the JSON body to
1 MiB, and applies recipient delivery reports through the provider-neutral
ledger. Correlation races return a retryable response so Event Grid can
redeliver after the accepted attempt is durable.

The Resend-shaped domain API is deliberately read-only for Azure: it checks
that the requested sender domain is verified and linked, and reports its
SPF/DKIM records. It never creates, changes, or deletes operator-owned Azure
resources or DNS.

The first hosted lifecycle pass on Cloud Run, Render, Railway, Fly.io, and
Vercel must use `HAYASEND_TRANSPORT=console`. That profile exercises durable
runtime semantics without external mail submission and does not require
SendGrid credentials. The experimental SendGrid adapter is the shared HTTP
transport for the separately approved terminal-delivery phase. Set:

| Variable | Meaning |
| --- | --- |
| `SENDGRID_API_KEY` or `SENDGRID_API_KEY_FILE` | Customer-owned scoped `SG.` API key used by migration, API, and worker processes |
| `SENDGRID_API_BASE_URL` | `https://api.sendgrid.com` (default) or `https://api.eu.sendgrid.com` for an eligible EU regional subuser |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` or `_FILE` | API process only: SendGrid verification key in the returned base64 form or PEM |

Configure SendGrid's Signed Event Webhook to call
`POST /events/sendgrid` with `processed`, `deferred`, `delivered`, `bounce`,
`dropped`, `spamreport`, `open`, and `click` enabled. HayaSend verifies ECDSA
over the timestamp plus the exact, unmodified request bytes before parsing the
JSON batch. Each event must carry the opaque HayaSend message and attempt
correlation values injected at submission; `sg_event_id` deduplicates retries
and the exact recipient updates the shared ledger. Bounce and spam-report
events create customer-owned suppressions. Unsubscribe-group events are
ignored until HayaSend exposes a matching model.

The v3 request fails before submission above 1,000 combined recipients, 20
attachments, 20,000,000 decoded attachment bytes, or the documented 30 MB
request ceiling. Only opaque HayaSend IDs enter SendGrid custom arguments;
addresses, subject, content, and user tags are not copied there. HTTP 202 and
`processed` are provider acceptance, never terminal delivery.

`HAYASEND_DATABASE_URL_FILE` and `HAYASEND_API_KEY_FILE` are mutually
exclusive alternatives to their unsuffixed variables. They must point to an
absolute, readable regular file of at most 16 KiB containing exactly one
value. This supports Cloud Run, Azure Container Apps, Kubernetes, and other
platforms that mount a secret rather than resolving it directly into an
environment variable. Secret contents and credential-bearing paths are never
included in diagnostics.

## Optional Cloud Run Pub/Sub wake-up

The Cloud Run pack can set `enable_pubsub_wakeup = true`. It gives the API
process only `HAYASEND_GCP_PUBSUB_TOPIC` and publisher IAM, and gives the
worker process only `HAYASEND_GCP_PUBSUB_SUBSCRIPTION` and subscriber IAM. The
migration process receives neither. Application Default Credentials authorize
the current Pub/Sub v1 REST publish, pull, and acknowledge methods.

The API persists the deterministic job in PostgreSQL before best-effort
publishing one fixed `hayasend_wakeup=1` attribute. No email ID, recipient,
subject/body, attachment, provider payload, or customer metadata enters
Pub/Sub. The worker treats a hint only as a reason to lease PostgreSQL. Pull
timeouts, unavailable Pub/Sub, lost hints, acknowledgment failure, and
redelivery all fall back to bounded database polling. Delayed jobs never enter
Pub/Sub, so its ten-minute subscription retention cannot own or truncate the
30-day scheduling contract.

## Attachment object storage

Direct attachment uploads are enabled by selecting one provider:

| Variable | Values / meaning |
| --- | --- |
| `HAYASEND_OBJECT_STORAGE` | `disabled` (default), `s3`, `gcs`, `azure-blob`, or `vercel-blob` |
| `HAYASEND_OBJECT_STORAGE_BUCKET` | Private bucket or Azure Blob container; omit for `vercel-blob` |
| `HAYASEND_S3_ENDPOINT` | Optional HTTPS origin for an S3-compatible service |
| `HAYASEND_S3_FORCE_PATH_STYLE` | `true` only when the S3-compatible service requires path-style requests |
| `GOOGLE_CLOUD_PROJECT` | Optional explicit GCP project; ADC remains authoritative |
| `AZURE_STORAGE_ACCOUNT_NAME` | Required for `azure-blob` |
| `HAYASEND_AZURE_BLOB_ENDPOINT` | Optional HTTPS service origin for a sovereign cloud or emulator |
| `BLOB_READ_WRITE_TOKEN` | Required 32–4096 character private-store token for `vercel-blob` |

The API issues a 15-minute, create/write-only upload URL. The signed contract
binds the declared SHA-256 as a native S3 checksum or provider metadata.
HayaSend verifies stored size and metadata when resolving the attachment, then
downloads and re-hashes the actual bytes immediately before transport
submission. A mismatched object never reaches the mail provider.

Provider identity requirements are:

- **S3-compatible:** use the AWS SDK credential chain and grant only bucket
  listing/readiness plus object create, read, and metadata access for the
  attachment prefix. Portable mode uses checksum metadata for compatibility;
  require private access and encryption through bucket policy/defaults.
- **Google Cloud Storage:** Application Default Credentials access the bucket.
  V4 signing also requires the API service account to sign blobs (normally
  `iam.serviceAccounts.signBlob`) in addition to scoped object access. The
  Cloud Run pack separates API, worker, and migration identities.
- **Azure Blob:** `DefaultAzureCredential` uses Managed Identity or the normal
  developer credential chain. The identity must have scoped Blob data access
  and permission to generate a user delegation key. HayaSend caches the
  one-hour delegation key and issues only HTTPS `cw` SAS tokens.
- **Vercel Blob:** use a private store and its production-scoped
  `BLOB_READ_WRITE_TOKEN`. HayaSend issues a no-overwrite signed URL for one
  exact pathname, content type, byte size, and expiry, then performs a private
  read and byte-level SHA-256 verification before transport submission.

Create the bucket/container ahead of the processes, keep public access
disabled, and apply provider lifecycle retention intentionally. Browser-based
direct uploads also need provider CORS allowing `PUT`, the documented checksum
metadata header, and the exact application origin. HayaSend never exports the
object, signed URL, body, or attachment to a Haya management plane.

The CLI trusts AWS S3, Google Cloud Storage, Azure Blob, and exact
`*.blob.vercel-storage.com` upload hosts by default. For a custom
S3-compatible origin, set the exact comma-separated HTTPS origins in
`HAYASEND_ATTACHMENT_UPLOAD_ORIGINS`; redirects remain disabled and only the
documented upload headers are forwarded.

The API binds to `0.0.0.0:$HAYASEND_PORT` in portable mode. `/healthz` is a
process liveness check. `/readyz` verifies that PostgreSQL is reachable, all
four packaged migrations are present, and the selected object-storage
bucket/container is accessible.

## Start order

Build once, then run:

```bash
npm run migrate:postgres
npm run start:api
npm run start:worker
```

The migration runner takes a session-level PostgreSQL advisory lock. Every
applied migration has a SHA-256 checksum, so parallel release jobs serialize
and modified history fails closed.

Do not start a new API or worker revision until its migration process succeeds.
The migrations are forward-only; a release rollback must keep a schema
compatible with the older application revision.

## Worker behavior

The worker:

- leases due rows with `FOR UPDATE SKIP LOCKED`;
- assigns one deterministic identity to duplicate publications;
- recovers expired leases after process loss;
- retries transient failures and terminally isolates permanent/exhausted jobs;
- stores only an allow-listed diagnostic category, never a raw provider error;
- reconciles the transactional outbox every second by default;
- releases its leases on `SIGTERM` or `SIGINT`; and
- removes completed/failed jobs after the configured retention period.

Relevant bounded tuning settings are:

| Variable | Default |
| --- | ---: |
| `HAYASEND_POSTGRES_POOL_MAX` | `10` |
| `HAYASEND_POSTGRES_IDLE_TIMEOUT_MS` | `10000` |
| `HAYASEND_POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` |
| `HAYASEND_POSTGRES_MAX_LIFETIME_SECONDS` | `3600` |
| `HAYASEND_WORKER_CONCURRENCY` | `4` |
| `HAYASEND_WORKER_LEASE_SECONDS` | `60` |
| `HAYASEND_WORKER_POLL_INTERVAL_MS` | `500` |
| `HAYASEND_WORKER_RETRY_DELAY_SECONDS` | `30` |
| `HAYASEND_WORKER_OUTBOX_INTERVAL_MS` | `1000` |
| `HAYASEND_JOB_MAX_ATTEMPTS` | `10` |
| `HAYASEND_JOB_RETENTION_DAYS` | `7` |

Size the sum of API and worker pool maxima below the managed PostgreSQL
connection limit. A pool URL may include provider-required `sslmode` settings;
do not log the URL because it may contain credentials.

## Current limitations

- Inline base64 attachments always work. Direct attachment uploads fail with
  explicit `503 attachment_storage_not_configured` when
  `HAYASEND_OBJECT_STORAGE=disabled`.
- Inbound receiving is disabled.
- `console` records an acceptance for development and must not be treated as
  real delivery.
- `aws-ses` can submit mail, but portable terminal event ingestion and
  cross-cloud credential evidence are not complete.
- `azure-communication-services` implements submission, strict 50-recipient
  and 10 MB preflight, exact-recipient Event Grid delivery reports, engagement
  retention, suppression convergence, and linked-domain inspection. It
  remains experimental until exact hosted terminal-delivery, controlled
  receipt, quota, lifecycle, rollback, backup/restore, and cleanup evidence
  pass.
- `sendgrid` implements v3 Mail Send submission, authenticated-domain
  lifecycle, privacy-safe error mapping, raw-body ECDSA webhook verification,
  exact-recipient delivery convergence, and bounce/complaint suppression. It
  remains experimental until each exact host passes conformance, lifecycle,
  terminal delivery, controlled receipt, backup/restore, and cleanup evidence.
- No Cloud Run, Azure Container Apps, Render, Railway, Fly.io, or Vercel
  deployment is claimed supported until its pinned deployment pack and lifecycle,
  backup/restore, terminal-delivery, and cleanup evidence pass. The
  [experimental Cloud Run pack](../deploy/cloud-run/README.md) is published,
  as are the [experimental Render pack](../deploy/render/README.md) and
  [experimental Railway pack](../deploy/railway/README.md) and
  [experimental Fly.io pack](../deploy/flyio/README.md) and
  [experimental Azure Container Apps pack](../deploy/azure-container-apps/README.md)
  and [experimental Vercel pack](../deploy/vercel/README.md), but their hosted
  evidence is still pending. Fly Managed Postgres currently uses PostgreSQL
  17 rather than the PostgreSQL 18 primary test substrate.

See [runtime portability](runtime-portability.md) for the full provider matrix.

## Official storage references

Checked on 2026-07-29:

- [Google Cloud Storage V4 signed URLs](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers)
- [Google Cloud Storage IAM permissions for signed URLs](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers#required-permissions)
- [Cloud Run resource model](https://docs.cloud.google.com/run/docs/resource-model)
- [Cloud Run Worker Pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools)
- [Cloud Run with Cloud SQL for PostgreSQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
- [Pub/Sub pull subscriptions](https://docs.cloud.google.com/pubsub/docs/pull)
- [Pub/Sub roles](https://docs.cloud.google.com/iam/docs/roles-permissions/pubsub)
- [Render Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Render deployment lifecycle](https://render.com/docs/deploys)
- [Render Postgres backups](https://render.com/docs/postgresql-backups)
- [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
- [Railway Storage Buckets](https://docs.railway.com/storage-buckets)
- [Railway volume backups](https://docs.railway.com/volumes/backups)
- [Fly.io app configuration](https://fly.io/docs/reference/configuration/)
- [Fly.io Managed Postgres](https://fly.io/docs/mpg/)
- [Fly.io Tigris object storage](https://fly.io/docs/tigris/)
- [Azure Blob user delegation SAS](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-user-delegation-sas-create-javascript)
- [Authorize access with Microsoft Entra ID](https://learn.microsoft.com/en-us/azure/storage/blobs/authorize-access-azure-active-directory)
- [Azure Communication Services Email JavaScript SDK](https://learn.microsoft.com/en-us/javascript/api/@azure/communication-email/)
- [Azure Communication Services limits](https://learn.microsoft.com/en-us/azure/communication-services/concepts/service-limits)
- [Azure Communication Services Email events](https://learn.microsoft.com/en-us/azure/event-grid/communication-services-email-events)
- [Azure Communication Services custom verified domains](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/add-custom-verified-domains)
- [Amazon S3 presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [Twilio SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send)
- [Twilio SendGrid Event Webhook](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
- [Twilio SendGrid Event Webhook security](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
