# Render deployment pack

This experimental Blueprint binds the shared `portable-postgres` runtime to:

- one public Render Web Service for the Resend-compatible API;
- one Render Background Worker for durable due-row and outbox recovery; and
- one private Render Postgres 18 database.

The Blueprint uses the signed `sendgrid` transport and starts with disabled
direct-upload storage. It can submit real mail after the operator supplies a
customer-owned scoped SendGrid API key, authenticated domain, and Signed Event
Webhook verification key. It offers inline attachments until an external
object store is selected. Render does not provide a native object store or
transactional-email transport.

The pack is not a Beta or production-readiness claim. Hosted deploy, rollback,
backup/restore, queue-loss, terminal delivery, controlled receipt, and cleanup
evidence remain required.

## Pinned inputs

Validated on 2026-07-29 with:

- Render CLI `2.22.0`;
- HayaSend `0.3.0` OCI index digest
  `sha256:458e9299ddef7a0d398e51cc18ce0daae2557cd444af55dadc67ae3e10bea519`;
- Render Postgres `18`;
- `starter` Web Service and Background Worker plans; and
- the `basic-256mb` paid database plan.

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
4. Enter one independently generated `re_` API key and the customer-owned
   `SENDGRID_API_KEY` and `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` when Render
   prompts. The worker references the API service values it needs instead of
   creating duplicate credentials; only the API receives the webhook key.
5. Configure SendGrid's Signed Event Webhook URL as
   `https://API_HOST/events/sendgrid` and enable processed, deferred,
   delivered, bounce, dropped, spamreport, open, and click events.
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
private connection string through `fromDatabase`.

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
export HAYASEND_IMAGE="ghcr.io/haya-inc/hayasend@sha256:458e9299ddef7a0d398e51cc18ce0daae2557cd444af55dadc67ae3e10bea519"
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

`HAYASEND_TRANSPORT=sendgrid` submits through the SendGrid v3 Mail Send API.
Only opaque HayaSend correlation values enter custom arguments, and the API
accepts events only after verifying the exact raw body with SendGrid's ECDSA
signature. Do not report HTTP 202, `processed`, or a queue result as terminal
delivery. Hosted proof remains tracked in issue #146 and readiness stays false
until every evidence gate passes.

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

## Official references

Checked on 2026-07-29:

- [Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Background workers](https://render.com/docs/background-workers)
- [Deploy lifecycle and pre-deploy commands](https://render.com/docs/deploys)
- [Rollbacks](https://render.com/docs/rollbacks)
- [Render Postgres backups and PITR](https://render.com/docs/postgresql-backups)
- [Render Postgres high availability](https://render.com/docs/postgresql-high-availability)
- [Render CLI releases](https://github.com/render-oss/cli/releases)
