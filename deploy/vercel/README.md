# Vercel serverless deployment pack

This experimental pack runs HayaSend as:

- one zero-configuration Hono application on Vercel Functions;
- one private Vercel Queues consumer that triggers bounded worker bursts;
- one authenticated minute Cron that reconciles missed or delayed work;
- one private Vercel Blob store for checksum-verified direct attachments; and
- one external PostgreSQL 18 database as the sole ledger, outbox, job, retry,
  and 30-day schedule authority.

The queue message contains only `{schema_version, kind}`. It never contains an
email ID, address, subject, body, attachment path, credential, or provider
error. Queue and Cron delivery may duplicate or overlap; PostgreSQL
transactional jobs and leases make this safe.

This pack is not a production-readiness claim. Vercel Queues and private Blob
are Beta, Vercel does not supply PostgreSQL or a native mail service, and
hosted lifecycle, restore, interruption, terminal-delivery, controlled-receipt,
and cleanup evidence remain pending. The first hosted lifecycle profile uses
the non-sending `console` transport. The reviewed external transport for a
separate terminal-delivery phase is the signed SendGrid adapter.

## Pinned inputs and platform limits

Validated on 2026-07-28 with:

- Vercel CLI `58.1.0`, pinned by npm registry integrity;
- `@vercel/queue` `0.4.0`;
- `@vercel/blob` `2.6.1`;
- `@vercel/functions` `3.7.6`;
- Node.js 24 or later; and
- PostgreSQL 18.

The reviewed project uses Fluid compute in `hnd1`, a 60-second public API
limit, and 300-second queue/Cron limits. Vercel Functions accept at most
4.5 MB request or response bodies. Attachments therefore use signed direct
Blob uploads rather than crossing the Function body.

Queues retain a message for at most seven days, and an idempotency key
deduplicates for at most 24 hours. HayaSend still supports schedules up to 30
days because PostgreSQL stores every due time and the minute Cron recovers any
lost wakeup. The queue is a latency accelerator, not storage.

## Create an isolated project

Use a dedicated Vercel Pro project. Pro is required for the reviewed
every-minute Cron schedule. Do not use a project that contains another
application because cleanup targets the whole project.

Install the pinned CLI in an operator-managed tool environment, authenticate,
and link the exact existing project:

```bash
vercel login
vercel link --team TEAM_ID --project PROJECT_ID
```

Record the three values in `.vercel/project.json`, then export them explicitly:

```bash
export HAYASEND_VERCEL_PROJECT_ID="prj_..."
export HAYASEND_VERCEL_ORG_ID="team_..."
export HAYASEND_VERCEL_PROJECT_NAME="hayasend-vercel"
```

Every lifecycle script requires all three values and refuses a mismatched
link. `.vercel/` remains local and must not be committed.

Create and connect one private Blob store in `hnd1` to production only:

```bash
vercel blob create-store hayasend-attachments \
  --access private \
  --region hnd1 \
  --environment production
```

Store the resulting `store_*` ID in the operations record. Keep
`BLOB_READ_WRITE_TOKEN` in Vercel production secrets and the password manager;
never place it in source, shell arguments, logs, or issues.

## External PostgreSQL

Provision a dedicated PostgreSQL 18 database with a connection pooler in or
near Tokyo. Require TLS, backups, point-in-time recovery if the provider
supports it, private credentials, connection alarms, and a tested restore.

Vercel instances scale independently, so an unpooled direct URL can exhaust
database connections. Start with:

```text
HAYASEND_POSTGRES_POOL_MAX=2
HAYASEND_WORKER_CONCURRENCY=1
HAYASEND_VERCEL_MAX_TICKS=8
```

Tune only from measured queue age, delivery latency, Function concurrency,
database connections, and provider quota. PostgreSQL must remain the durable
authority even if another accelerator is introduced.

## Production environment

Configure at least these Vercel production variables:

| Variable | Value |
| --- | --- |
| `HAYASEND_MODE` | `portable` |
| `HAYASEND_DATABASE_URL` | secret pooled PostgreSQL URL with provider-required TLS |
| `HAYASEND_API_KEY` | independent secret `re_...` bootstrap key |
| `HAYASEND_TRANSPORT` | `console` for the first lifecycle proof |
| `HAYASEND_CONSOLE_PROOF_CONFIRM` | `isolated-non-sending` for the console lifecycle only |
| `HAYASEND_OBJECT_STORAGE` | `vercel-blob` |
| `BLOB_READ_WRITE_TOKEN` | token automatically connected from the private store |
| `CRON_SECRET` | independently generated random secret of 32–512 characters |
| `HAYASEND_POSTGRES_POOL_MAX` | initially `2` |
| `HAYASEND_WORKER_CONCURRENCY` | initially `1` |
| `HAYASEND_VERCEL_MAX_TICKS` | initially `8` |

Vercel sends `Authorization: Bearer $CRON_SECRET` to the configured Cron
route. HayaSend validates it in constant time. The Queue trigger makes
`api/queue.ts` air-gapped from the public internet.

The lifecycle profile contains no `SENDGRID_*` values and cannot submit mail.
The deploy script requires and passes the exact console proof confirmation;
SendGrid deployments omit it. Run the
[shared portable hosted proof](https://github.com/haya-inc/hayasend/blob/main/docs/portable-hosted-proof.md)
from an approved private database execution path. Vercel Cron or Queue
reconciliation must recover the deliberately lost wake-up within the selected
proof timeout.

After it passes recovery, interruption, long-delay, restore, rollback, and
cleanup tests, set `HAYASEND_TRANSPORT=sendgrid`, add the customer-owned scoped
`SENDGRID_API_KEY` and `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`, and redeploy for the
separately approved transport phase. Configure SendGrid's Signed Event Webhook
URL as `https://HAYASEND_VERCEL_API_URL/events/sendgrid` and enable processed,
deferred, delivered, bounce, dropped, spamreport, open, and click events. Only
opaque HayaSend correlation values enter custom arguments, and the ingress
verifies the exact raw body with SendGrid's ECDSA signature.

## Deploy and verify

Export the same four secrets locally only for migration and verification:

```bash
export HAYASEND_DATABASE_URL="postgresql://..."
export HAYASEND_API_KEY="re_..."
export BLOB_READ_WRITE_TOKEN="..."
export CRON_SECRET="..."
export HAYASEND_TRANSPORT="console"
export HAYASEND_VERCEL_API_URL="https://your-production-origin.example"
./deploy/vercel/deploy.sh
```

The script verifies the pinned CLI and exact linked project, installs from the
lockfile, runs type/config checks, builds, executes checksum-pinned migrations,
passes the reviewed non-secret transport selection explicitly to the
production deployment, waits for the exact deployment to become `READY`, and
then verifies:

- `/healthz` and PostgreSQL/Blob `/readyz`;
- the Queue handler returns public HTTP 404;
- the Cron route returns HTTP 401 without its secret; and
- one authenticated, privacy-safe worker burst succeeds.

It does not put secrets on CLI arguments. Vercel production variables must
already be configured and must match the locally exported verification
values.

HTTP 202, `processed`, Queue acknowledgment, and successful Cron execution are
not terminal delivery evidence. Hosted proof remains tracked in issue #155 and
readiness stays false until every evidence gate passes.

## Rollback

Select one exact prior `READY` deployment from the same project:

```bash
export HAYASEND_VERCEL_ROLLBACK_DEPLOYMENT="https://previous.vercel.app"
export HAYASEND_VERCEL_API_URL="https://production.example"
./deploy/vercel/rollback.sh
```

Forward migrations must remain compatible with that prior application.
Vercel's instant rollback does not automatically update the active Cron
definition. If `vercel.json` changed its Cron path or schedule, redeploy the
reviewed configuration and inspect the Cron Jobs page before accepting the
rollback.

## Cleanup

Delete all attachment objects and separately delete the external PostgreSQL
database, snapshots, backups, connection-pool resources, and credentials.
Then run:

```bash
export HAYASEND_ALLOW_DESTROY=vercel
export HAYASEND_VERCEL_DEDICATED_PROJECT=true
export HAYASEND_EXTERNAL_POSTGRES_CLEANUP_CONFIRMED=true
export HAYASEND_VERCEL_BLOB_STORE_ID="store_..."
export BLOB_READ_WRITE_TOKEN="..."
./deploy/vercel/cleanup.sh
```

The script validates the exact link, verifies the private store is empty,
deletes that exact store, requires interactive confirmation of the exact
project name, and verifies project absence. Independently verify domain/DNS
detachment, environment variables, team tokens, Queue usage, Cron inventory,
external database backups, transport resources, observability retention, and
billing. The script alone is not zero-residue evidence.

## Official references

Checked on 2026-07-28:

- [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono)
- [Vercel Queues](https://vercel.com/docs/queues)
- [Seven-day Queue TTL](https://vercel.com/changelog/queues-now-supports-7-day-ttl)
- [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)
- [Signed Blob URLs](https://vercel.com/changelog/signed-urls-are-now-available-for-vercel-blob)
- [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage)
- [Vercel CLI project targeting](https://vercel.com/docs/cli/global-options#project)
- [Vercel rollback](https://vercel.com/docs/cli/rollback)
