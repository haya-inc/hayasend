# Railway deployment pack

This experimental Railway Infrastructure as Code pack binds HayaSend's shared
`portable-postgres` runtime to:

- one public API service;
- one continuously running worker;
- one Railway PostgreSQL 18 service; and
- one private, S3-compatible Railway Bucket for direct-upload attachments.

The pack starts with the non-sending `console` transport so the hosted runtime
lifecycle can be proven without external submission credentials or mail.
Railway has no native transactional-email service; the signed SendGrid HTTP
transport remains an explicit second-phase option. Railway IaC is itself
experimental, so this pack is not a Beta or production-readiness claim.

## Pinned inputs

Validated on 2026-07-29 with:

- Railway CLI `5.30.1`;
- Railway IaC SDK `railway@3.6.0`;
- HayaSend `0.3.1` OCI index digest
  `sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979`;
- PostgreSQL `18`;
- the Singapore Railway compute region
  `asia-southeast1-eqsg3a`; and
- the Singapore Bucket region `sin`;
- one replica per process capped at 0.5 vCPU, 512 MiB RAM, and 1 GiB ephemeral
  disk for the disposable proof.

The reviewed image uses an immutable digest and disables Railway image
auto-updates. Repository CI downloads the current pinned CLI release, verifies
its GitHub-published SHA-256 digest, evaluates the TypeScript graph with the
official SDK, and checks every shell guard.

Before applying the graph, configure the workspace Compute Usage hard limit
and alert in Railway's Usage settings. The per-replica limits in this pack
bound each process, but only the workspace hard limit caps aggregate compute,
database, storage, and egress charges. Production limits must be reviewed
separately.

## Create the isolated project

Create a new empty Railway project named exactly `hayasend-railway`. Do not use
a project that contains another application: cleanup intentionally deletes the
whole project and refuses any unexpected service or bucket.

Install and authenticate the pinned CLI:

```bash
railway login
```

Record the exact lowercase project and environment UUIDs. Generate an API key
outside source control:

```bash
export HAYASEND_API_KEY="re_$(openssl rand -hex 32)"
export HAYASEND_TRANSPORT="console"
```

Keep the key in a password/operations system. Do not place it in the IaC file,
shell history, logs, issue comments, or evidence.

## Deploy

From `deploy/railway`, export the non-secret identifiers and immutable image:

```bash
export HAYASEND_RAILWAY_PROJECT_ID="00000000-0000-4000-8000-000000000000"
export HAYASEND_RAILWAY_ENVIRONMENT_ID="00000000-0000-4000-8000-000000000000"
export HAYASEND_RAILWAY_WORKSPACE_ID="00000000-0000-4000-8000-000000000000"
export HAYASEND_IMAGE="ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979"
./deploy.sh
```

The script links through a temporary directory, obtains a redacted plan,
refuses destructive changes, applies only the reviewed graph, waits for both
deployments, creates a Railway service domain, and runs `verify.sh`. It never
uses `--show-values`; Railway redacts variables in the plan by default.

Both services run the checksum-pinned PostgreSQL migration command before
starting. PostgreSQL advisory locking makes concurrent first deployment safe.
Forward migrations must remain compatible with the immediately previous API
and worker revisions.

The default graph contains no `SENDGRID_*` variables and cannot submit mail.
For console deployments it injects the exact
`HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending` runtime guard; the value
is absent from the SendGrid graph. The IaC always declares
`HAYASEND_RUNTIME_PROFILE=portable-postgres` and adds the exact
`HAYASEND_DEPLOYMENT_PROFILE=railway-sendgrid` binding only when SendGrid is
selected. Run the
[shared portable hosted proof](https://github.com/haya-inc/hayasend/blob/main/docs/portable-hosted-proof.md)
from an approved private path to verify PostgreSQL-owned scheduling, recovery,
and fixture cleanup.

After lifecycle, recovery, upgrade, rollback, backup/restore, and cleanup
behavior has been proven, opt in to the separately approved transport phase:

```bash
export HAYASEND_TRANSPORT="sendgrid"
export SENDGRID_API_KEY="SG...."
export SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY="..."
./deploy.sh
```

Configure SendGrid's Signed Event Webhook URL as
`https://HAYASEND_RAILWAY_API_URL/events/sendgrid` and enable processed,
deferred, delivered, bounce, dropped, spamreport, open, and click events.
Only the API service receives the webhook verification key; both application
services receive the scoped Mail Send/domain-authentication API key.

Run later drift and health verification with the same API key:

```bash
export HAYASEND_RAILWAY_API_URL="https://your-service.up.railway.app"
./verify.sh
```

## Storage boundary

The pack uses a private Railway Bucket through HayaSend's S3 adapter.
Credentials are Railway resource references, not literals in source. The
bucket supports presigned URLs and is encrypted at rest.

Current Railway Bucket limitations are material:

- no object versioning, object locks, lifecycle configuration, or
  customer-selected server-side encryption mode;
- no automatic bucket snapshots/backups; and
- public-network access only.

HayaSend uses virtual-hosted S3 URLs (`HAYASEND_S3_FORCE_PATH_STYLE=false`).
The bucket-provided AWS credential variables are storage credentials, not SES
credentials.

## Transport boundary

`HAYASEND_TRANSPORT=console` is the fail-closed lifecycle default.
`HAYASEND_TRANSPORT=sendgrid` submits through the SendGrid v3 Mail Send API
only after the two required SendGrid values are supplied. Railway Bucket
credentials remain isolated from the SendGrid credential. Only opaque
HayaSend correlation values enter SendGrid custom arguments, and the public
ingress verifies the exact raw body with SendGrid's ECDSA signature.

Terminal recipient delivery, bounce, complaint, suppression, and controlled
receipt evidence remain mandatory. A successful Railway deployment, SendGrid
HTTP 202, or `processed` event is not terminal delivery evidence. Hosted proof
remains tracked in issue #148.

## Backups, availability, and rollback

Railway PostgreSQL is customer-operated infrastructure. Configure native
volume backup schedules and prove a restore. Current schedules retain daily
backups for six days, weekly backups for one month, and monthly backups for
three months. This is not point-in-time recovery.

Railway offers a PostgreSQL 18 HA conversion using Patroni, etcd, and HAProxy,
but that is a separate topology and acceptance exercise. The base pack starts
with one database and one replica of each HayaSend service. Prove sizing,
failure recovery, upgrade, rollback, and database restoration before
promotion.

## Cleanup

Delete all attachment objects first. Then verify that the project contains
only the three named services and one named bucket:

```bash
export HAYASEND_ALLOW_DESTROY=railway
export HAYASEND_RAILWAY_DEDICATED_PROJECT=true
./cleanup.sh
```

If a deployment failed before the full graph was created, the integration
workflow may additionally set
`HAYASEND_RAILWAY_ALLOW_PARTIAL=true`. This still requires the exact project
and environment UUIDs, the exact `hayasend-railway` project name, a single
non-ephemeral `production` environment, and only a subset of the three
HayaSend services and one HayaSend bucket. It refuses any unexpected resource
or non-empty bucket before deleting the whole dedicated project.

If Railway requires MFA for non-interactive deletion, additionally provide the
current six-digit `RAILWAY_2FA_CODE`. The script validates the exact project
name, project/environment UUIDs, resource inventory, and zero bucket objects
before requesting permanent project deletion.

Railway may report deletion as scheduled, and Bucket deletion has a two-day
protective delay. Independently verify final project absence, retained
database/volume backups, bucket deletion, custom domains, variables, tokens,
external transport resources, and billing. The script alone is not
zero-residue evidence.

## GitHub-hosted console proof

`.github/workflows/railway-integration.yml` runs the first non-sending hosted
proof from the protected `railway-integration` environment. Before dispatch,
create the empty dedicated project and configure these environment values:

- `RAILWAY_TEST_PROJECT_ID`;
- `RAILWAY_TEST_ENVIRONMENT_ID`;
- `RAILWAY_TEST_WORKSPACE_ID`;
- `RAILWAY_TEST_PROJECT_NAME=hayasend-railway`;
- `RAILWAY_TEST_ACCOUNT_KIND=general-purpose-test`;
- `RAILWAY_TEST_PLAN=hobby`;
- `RAILWAY_TEST_COMPUTE_HARD_LIMIT_USD=10`; and
- an account- or workspace-scoped secret `RAILWAY_API_TOKEN`.

The workflow runs only on protected `main` and requires the exact project UUID
and proposed USD 10 ceiling as dispatch confirmations,
refuses non-empty or multi-environment projects, downloads and verifies the
pinned CLI, creates a masked one-run HayaSend API key, applies the reviewed
console-only graph, runs the semantic proof inside the API container, checks
drift, and always requests guarded deletion of the dedicated project. It does
not configure Railway billing or usage limits; the environment values are an
operator assertion and the current plan and hard limit must be checked in the
Railway Usage screen before approval and dispatch. The final provider
inventory and billing page still require independent verification.

## Official references

Checked on 2026-07-29:

- [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
- [Railway IaC reference](https://docs.railway.com/infrastructure-as-code/reference)
- [Railway CLI](https://docs.railway.com/cli)
- [Railway regions](https://docs.railway.com/deployments/regions)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway volume backups](https://docs.railway.com/volumes/backups)
- [Railway PostgreSQL HA](https://docs.railway.com/databases/postgresql-ha)
- [Railway Buckets](https://docs.railway.com/storage-buckets)
