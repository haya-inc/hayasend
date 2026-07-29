# Render deployment pack

This experimental Blueprint binds the shared `portable-postgres` runtime to:

- one public Render Web Service for the Resend-compatible API;
- one Render Background Worker for durable due-row and outbox recovery; and
- one private Render Postgres 18 database.

The Blueprint starts with the non-sending `console` transport and disabled
direct-upload storage. This is the lifecycle-proof profile: it can exercise
API acceptance, durable jobs, worker recovery, upgrades, rollback, and
database restore without submitting mail to an external provider. It offers
inline attachments until an external object store is selected. Render does
not provide a native object store or transactional-email transport.

The pack is not a Beta or production-readiness claim. Hosted deploy, rollback,
backup/restore, queue-loss, terminal delivery, controlled receipt, and cleanup
evidence remain required.

## Pinned inputs

Validated on 2026-07-29 with:

- Render CLI `2.22.0`;
- HayaSend `0.3.1` OCI index digest
  `sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979`;
- Render Postgres `18`;
- `starter` Web Service and Background Worker plans; and
- the `basic-256mb` paid database plan with an explicit 1 GB disk and storage
  autoscaling disabled for the disposable proof.

The current CLI release and its downloaded checksum were independently
verified before validation. The Blueprint disables automatic deploys and
preview environments so a moving tag, repository push, or pull request cannot
silently create a new runtime or billable data plane.

## Create the Blueprint

1. Fork or mirror the HayaSend repository into a source repository your Render
   workspace can access.
2. In the Render Dashboard, create a Blueprint and select
   `deploy/render/render.yaml` as its Blueprint path.
3. Review all three paid resources, the Singapore region, and the exact image
   digest before applying.
4. Enter one independently generated `re_` API key when Render prompts. The
   worker references the API service value instead of creating a duplicate
   credential.
5. Confirm both services have `HAYASEND_TRANSPORT=console` and no
   `SENDGRID_*` variables before the first deploy. Also confirm both carry the
   committed
   `HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending` guard.
6. Record the exact `srv-*` API and worker IDs, the `dpg-*` database ID, and the
   API's `https://*.onrender.com` origin in your password/operations system.

Generate the API key outside source control:

```bash
export HAYASEND_API_KEY="re_$(openssl rand -hex 32)"
```

Do not place this value in `render.yaml`, shell history, deploy hooks, logs, or
evidence. Render's `sync: false` field keeps it out of the Blueprint file but
Render still stores and injects it within the customer's workspace.

The database has an empty public IP allow list. Both services receive its
private connection string through `fromDatabase`. The disposable proof fixes
storage at the provider minimum instead of accepting the larger Blueprint
default or one-way automatic growth. Production sizing must be reviewed
separately.

## Deploy an exact image

Install and authenticate the pinned Render CLI:

```bash
render login
render workspace set
```

Then export only non-secret resource identifiers and the released digest:

```bash
export RENDER_API_SERVICE_ID="srv-..."
export RENDER_WORKER_SERVICE_ID="srv-..."
export HAYASEND_RENDER_API_URL="https://hayasend-api.onrender.com"
export HAYASEND_IMAGE="ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979"
./deploy.sh
./verify.sh
```

`deploy.sh` updates the API first and the worker second. Each paid service runs
the checksum-pinned migration command on a separate pre-deploy instance before
starting its new revision. PostgreSQL advisory locking makes concurrent initial
Blueprint migrations safe. Forward migrations must remain compatible with the
immediately previous API and worker revisions.

Render keeps the previous successful service running when a build,
pre-deploy, health check, or start fails. Services without persistent disks use
zero-downtime deploys. HayaSend stores durable state only in PostgreSQL and the
selected external object store; it does not attach a Render persistent disk.

## Storage boundary

`HAYASEND_OBJECT_STORAGE=disabled` is the safe default. Inline base64
attachments continue to work, while direct-upload requests fail explicitly.

To enable direct uploads, configure one existing customer-controlled backend
on both services:

- `s3` with an S3-compatible bucket, endpoint, and short-lived or scoped AWS
  credentials;
- `gcs` with workload identity or a narrowly scoped customer credential; or
- `azure-blob` with a managed/customer identity that can issue user-delegation
  SAS tokens.

Never paste a broad cloud-account key into the Blueprint. Render has no native
workload identity for arbitrary external clouds, so the exact credential and
rotation design is part of the combination evidence.

## Transport boundary

The committed lifecycle profile uses `HAYASEND_TRANSPORT=console` and cannot
submit mail. Production-built console mode refuses to start unless the exact
`HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending` guard is present.
Run the
[shared portable hosted proof](https://github.com/haya-inc/hayasend/blob/main/docs/portable-hosted-proof.md)
from an approved private path before moving to the transport phase.

After the lifecycle, recovery, upgrade, rollback, and restore
proofs pass, an independently reviewed transport phase may set
`HAYASEND_TRANSPORT=sendgrid` and
`HAYASEND_DEPLOYMENT_PROFILE=render-sendgrid` on both services, add a scoped
`SENDGRID_API_KEY` to both services, and add
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` to the API only. Keep the committed
`HAYASEND_RUNTIME_PROFILE=portable-postgres` declaration. Configure
the Signed Event Webhook URL as `https://API_HOST/events/sendgrid` and enable
processed, deferred, delivered, bounce, dropped, spamreport, open, and click
events. Only opaque HayaSend correlation values enter custom arguments, and
the API accepts events only after verifying the exact raw body with SendGrid's
ECDSA signature. Do not report HTTP 202, `processed`, or a queue result as
terminal delivery. Hosted proof remains tracked in issue #146 and readiness
stays false until every evidence gate passes.

## Scaling, backups, and rollback

- The Blueprint uses one API and one continuously running worker. Increase
  capacity only after sizing the sum of PostgreSQL connection pools below the
  database limit.
- Paid Render Postgres includes point-in-time recovery. The Hobby workspace
  window is currently three days and Pro-or-higher is seven days.
- The starter database is suitable for implementation proof, not a production
  recommendation. Production evaluation must select sufficient compute,
  storage, retention, and—where required—a Pro/Accelerated plan with HA.
- Render rollbacks preserve the exact image tag or digest of the target deploy.
  Run the shared rollback and data-compatibility drill before promotion.

## Cleanup

First unlink the Blueprint in the Dashboard so a future sync cannot recreate
resources. Confirm that no unrelated resource uses the database, then run:

```bash
export RENDER_API_SERVICE_ID="srv-..."
export RENDER_WORKER_SERVICE_ID="srv-..."
export RENDER_POSTGRES_ID="dpg-..."
export HAYASEND_RENDER_BLUEPRINT_UNLINKED=true
export HAYASEND_ALLOW_DESTROY=render
./cleanup.sh
```

The script accepts exact resource IDs only, deletes the worker and API before
the database, and fails if the IDs remain in CLI inventory. Independently
verify Blueprint metadata, custom domains, environment values, deploy hooks,
PITR/recovery copies, logical exports, external object storage, external
transport resources, and billing. Provider retention behavior means the script
alone is not zero-residue evidence.

## GitHub-hosted console proof

`.github/workflows/render-integration.yml` is a manual-only lifecycle proof on
protected `main`. Create the reviewed Blueprint in an otherwise isolated
general-purpose test workspace, leave autosync off, enter one independent
`HAYASEND_API_KEY` in the API's unsynced value, and configure the
`render-integration` GitHub environment with the exact:

- `RENDER_TEST_OWNER_ID`, project, production environment, Blueprint, API,
  worker, and PostgreSQL IDs;
- `RENDER_TEST_API_URL`;
- `RENDER_TEST_PROJECT_NAME=hayasend-render`;
- `RENDER_TEST_ACCOUNT_KIND=general-purpose-test`;
- `RENDER_TEST_SERVICE_PLAN=starter`;
- `RENDER_TEST_POSTGRES_PLAN=basic-256mb`;
- `RENDER_TEST_COST_CEILING_USD=30`;
- `RENDER_TEST_DURATION_MINUTES=45`; and
- workspace-scoped `RENDER_API_KEY` environment secret.

Before mutation the workflow verifies the one-environment, two-service,
one-database Blueprint graph, network isolation, no custom domains, exact
plans, and disabled autosync. Dispatch must repeat the exact project ID and
proposed USD 30 ceiling. It first deploys the immutable v0.3.0 compatibility
baseline, upgrades both services to the immutable current image, runs the
30-day console proof as one exact Render one-off job, and uses the guarded
rollback wrapper to redeploy v0.3.0 without reversing forward migrations. It
records baseline, upgrade, and rollback evidence before disconnecting the
Blueprint and deleting the dedicated project. It does not configure external
object storage or SendGrid and does not send mail. It is implemented and
locally validated, but has not yet been run.

## Official references

Checked on 2026-07-29:

- [Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Background workers](https://render.com/docs/background-workers)
- [Deploy lifecycle and pre-deploy commands](https://render.com/docs/deploys)
- [Rollbacks](https://render.com/docs/rollbacks)
- [Render Postgres backups and PITR](https://render.com/docs/postgresql-backups)
- [Render Postgres high availability](https://render.com/docs/postgresql-high-availability)
- [Render CLI releases](https://github.com/render-oss/cli/releases)
