# Portable PostgreSQL runtime

The portable runtime is the shared container foundation for Cloud Run, Azure
Container Apps, Render, Railway, and Fly.io. It is executable, but is not yet
a supported Beta deployment: object-storage adapters, provider event ingress,
backup/restore evidence, and each platform deployment proof remain open.

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

The API binds to `0.0.0.0:$HAYASEND_PORT` in portable mode. `/healthz` is a
process liveness check. `/readyz` verifies that PostgreSQL is reachable and all
three packaged migrations are present.

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

- Inline base64 attachments work. Direct attachment uploads fail with an
  explicit `503 attachment_storage_not_configured` until an object-storage
  adapter is selected.
- Inbound receiving is disabled.
- `console` records an acceptance for development and must not be treated as
  real delivery.
- `aws-ses` can submit mail, but portable terminal event ingestion and
  cross-cloud credential evidence are not complete.
- No Cloud Run, Azure Container Apps, Render, Railway, or Fly.io deployment is
  claimed supported until its pinned deployment pack and lifecycle,
  backup/restore, terminal-delivery, and cleanup evidence pass.

See [runtime portability](runtime-portability.md) for the full provider matrix.
