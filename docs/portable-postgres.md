# Portable PostgreSQL runtime

The portable runtime is the shared container foundation for Cloud Run, Azure
Container Apps, Render, Railway, and Fly.io. It is executable, but is not yet
a supported Beta deployment: provider event ingress, backup/restore evidence,
and each platform deployment proof remain open.

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
| `HAYASEND_TRANSPORT` | `aws-ses` for real SES submission or `console` for development only |
| `AWS_REGION` | SES Region when `HAYASEND_TRANSPORT=aws-ses` |

`aws-ses` also needs AWS credentials supplied through the AWS SDK credential
chain and optional `HAYASEND_CONFIGURATION_SET`. Cross-cloud identity and
terminal SES event ingress are not yet certified.

`HAYASEND_DATABASE_URL_FILE` and `HAYASEND_API_KEY_FILE` are mutually
exclusive alternatives to their unsuffixed variables. They must point to an
absolute, readable regular file of at most 16 KiB containing exactly one
value. This supports Cloud Run, Azure Container Apps, Kubernetes, and other
platforms that mount a secret rather than resolving it directly into an
environment variable. Secret contents and credential-bearing paths are never
included in diagnostics.

## Attachment object storage

Direct attachment uploads are enabled by selecting one provider:

| Variable | Values / meaning |
| --- | --- |
| `HAYASEND_OBJECT_STORAGE` | `disabled` (default), `s3`, `gcs`, or `azure-blob` |
| `HAYASEND_OBJECT_STORAGE_BUCKET` | Private bucket or Azure Blob container |
| `HAYASEND_S3_ENDPOINT` | Optional HTTPS origin for an S3-compatible service |
| `HAYASEND_S3_FORCE_PATH_STYLE` | `true` only when the S3-compatible service requires path-style requests |
| `GOOGLE_CLOUD_PROJECT` | Optional explicit GCP project; ADC remains authoritative |
| `AZURE_STORAGE_ACCOUNT_NAME` | Required for `azure-blob` |
| `HAYASEND_AZURE_BLOB_ENDPOINT` | Optional HTTPS service origin for a sovereign cloud or emulator |

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
  V4 signing also requires the runtime service account to sign blobs (normally
  `iam.serviceAccounts.signBlob`) in addition to scoped object access.
- **Azure Blob:** `DefaultAzureCredential` uses Managed Identity or the normal
  developer credential chain. The identity must have scoped Blob data access
  and permission to generate a user delegation key. HayaSend caches the
  one-hour delegation key and issues only HTTPS `cw` SAS tokens.

Create the bucket/container ahead of the processes, keep public access
disabled, and apply provider lifecycle retention intentionally. Browser-based
direct uploads also need provider CORS allowing `PUT`, the documented checksum
metadata header, and the exact application origin. HayaSend never exports the
object, signed URL, body, or attachment to a Haya management plane.

The CLI trusts AWS S3, Google Cloud Storage, and Azure Blob upload hosts by
default. For a custom S3-compatible origin, set the exact comma-separated
HTTPS origins in `HAYASEND_ATTACHMENT_UPLOAD_ORIGINS`; redirects remain
disabled and only the documented upload headers are forwarded.

The API binds to `0.0.0.0:$HAYASEND_PORT` in portable mode. `/healthz` is a
process liveness check. `/readyz` verifies that PostgreSQL is reachable, all
three packaged migrations are present, and the selected object-storage
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
- No Cloud Run, Azure Container Apps, Render, Railway, or Fly.io deployment is
  claimed supported until its pinned deployment pack and lifecycle,
  backup/restore, terminal-delivery, and cleanup evidence pass. The
  [experimental Cloud Run pack](../deploy/cloud-run/README.md) is published,
  as is the [experimental Render pack](../deploy/render/README.md), but their
  hosted evidence is still pending.

See [runtime portability](runtime-portability.md) for the full provider matrix.

## Official storage references

Checked on 2026-07-28:

- [Google Cloud Storage V4 signed URLs](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers)
- [Google Cloud Storage IAM permissions for signed URLs](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers#required-permissions)
- [Cloud Run resource model](https://docs.cloud.google.com/run/docs/resource-model)
- [Cloud Run Worker Pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools)
- [Cloud Run with Cloud SQL for PostgreSQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
- [Render Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Render deployment lifecycle](https://render.com/docs/deploys)
- [Render Postgres backups](https://render.com/docs/postgresql-backups)
- [Azure Blob user delegation SAS](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-user-delegation-sas-create-javascript)
- [Authorize access with Microsoft Entra ID](https://learn.microsoft.com/en-us/azure/storage/blobs/authorize-access-azure-active-directory)
- [Amazon S3 presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
