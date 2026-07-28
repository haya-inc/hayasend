# Cloud Run deployment pack

This experimental pack binds the shared `portable-postgres` runtime to:

- a Cloud Run service for the Resend-compatible API;
- a Cloud Run Worker Pool for continuous reconciliation and delivery work;
- a one-shot Cloud Run Job for checksum-pinned forward migrations;
- Cloud SQL for PostgreSQL 18;
- a private Google Cloud Storage attachment bucket; and
- optional content-free Pub/Sub wake-up hints;
- Secret Manager file mounts plus separate API, worker, and migration service
  accounts; and
- a dedicated Direct VPC subnet plus Private Services Access for Cloud SQL.

It is an implementation pack, not a production-readiness claim. Cloud Run
Worker Pools remain a Beta resource, the default `console` transport does not
deliver mail, and hosted backup/restore, rollback, zero-residue, terminal
delivery, and controlled-receipt evidence are still required.

## Security model

- The API, worker, and migration job run the same immutable image digest.
- `api_key` and `database_password` are Terraform 1.15 ephemeral variables.
  The Google provider receives them only through write-only arguments, so the
  values are not stored in Terraform state.
- Cloud Run mounts exact Secret Manager versions as read-only files. HayaSend
  reads each secret through one bounded file descriptor and does not log it.
- Cloud SQL has no public IPv4 address. It is reached through its encrypted
  Cloud Run connector and Unix socket over a dedicated Direct VPC subnet and
  Private Services Access. Connector enforcement rejects bypass connections.
- The GCS bucket enforces public-access prevention and uniform bucket-level
  access. The API and worker get object access only on that bucket, while only
  the API identity may sign its own short-lived V4 upload URLs.
- When enabled, only the API identity can publish to the wake-up topic and only
  the worker identity can consume the pull subscription. The migration job
  receives neither Pub/Sub configuration nor Pub/Sub IAM.
- The default Cloud SQL instance is regional, has SSD auto-growth, backups,
  point-in-time recovery, Query Insights, and deletion protection.

Terraform state can still contain resource metadata. Store it in an encrypted,
access-controlled backend with locking. Do not commit state or `.tfvars`.
For production, create a separate access-controlled GCS state bucket, copy
`backend.tf.example` to the ignored `backend.tf`, and initialize with the
bucket and a unique prefix:

```bash
terraform init \
  -backend-config="bucket=your-terraform-state-bucket" \
  -backend-config="prefix=hayasend/cloud-run"
```

The state bucket is intentionally outside this module so destroying HayaSend
cannot delete its own audit trail or state lock.

## Versions

The pack was validated on 2026-07-29 with:

- Terraform `1.15.8`;
- HashiCorp Google provider `7.41.0`;
- Google Cloud PostgreSQL `18`; and
- the Cloud Run v2 Service, Job, and Worker Pool resources.

The optional wake-up adapter uses `google-auth-library` 10.9.1 and the current
Pub/Sub v1 REST publish/pull/acknowledge contract. The latest
`@google-cloud/pubsub` 5.3.1 package was evaluated but not adopted because its
then-current dependency graph introduced known audit findings. HayaSend keeps
`npm audit` at zero rather than overriding incompatible transitive majors.

The exact constraints and multi-platform provider checksums are committed.

## Prerequisites

1. Select a customer-controlled Google Cloud project with billing enabled.
2. Install Terraform 1.15.x, Google Cloud CLI, `jq`, and `curl`.
3. Authenticate Terraform and `gcloud` using Application Default Credentials
   or Workload Identity Federation. Do not create a long-lived service-account
   key for this pack.
4. Choose a released public GHCR image or an Artifact Registry image and pin
   its `sha256` digest.
5. Copy `terraform.tfvars.example` to an ignored `terraform.tfvars` and edit
   only non-secret settings.

Generate independent secrets without writing them to a file or command-line
argument:

```bash
export TF_VAR_project_id="your-gcp-project-id"
export TF_VAR_image="ghcr.io/haya-inc/hayasend@sha256:..."
export TF_VAR_api_key="re_$(openssl rand -hex 32)"
export TF_VAR_database_password="$(openssl rand -base64 48 | tr -d '\n')"
```

The two values remain in the current shell environment. Move operational
copies into your normal password/secret-management workflow before clearing
the shell.

## Safe two-stage deploy

Run:

```bash
./deploy.sh
```

The script intentionally performs:

1. a targeted infrastructure plus migration-job update that leaves any
   existing API and worker revision untouched;
2. one blocking migration execution;
3. the full API and Worker Pool plan only after migration succeeds; and
4. an exact `/readyz` check.

On a first deployment, the targeted stage creates only the migration job and
its dependencies. On upgrades, it updates the migration job while leaving the
currently serving API and worker revision running. This prevents a new
application revision from starting against an unapplied schema. Forward
migrations must remain compatible with the immediately previous application
revision to support rollback.

## Mail transport boundary

`transport = "console"` is the safe default and records acceptance without
sending. It is suitable only for deployment and lifecycle proof.

`transport = "sendgrid"` uses the portable signed SendGrid adapter. Supply the
scoped key and Event Webhook verification key through write-only Terraform
variables:

```bash
export TF_VAR_transport="sendgrid"
export TF_VAR_sendgrid_api_key="SG...."
export TF_VAR_sendgrid_event_webhook_public_key="..."
```

After deploy, configure SendGrid's Signed Event Webhook URL as
`https://API_HOST/events/sendgrid` and enable `processed`, `deferred`,
`delivered`, `bounce`, `dropped`, `spamreport`, `open`, and `click` events.
The API key is mounted in API, worker, and migration processes; the verification
key is mounted only in the public API process. Hosted proof remains tracked in
issue #144 and readiness stays false until every evidence gate passes.

`transport = "aws-ses"` exercises the existing transport but needs a deliberate
cross-cloud AWS credential strategy and terminal SES event ingress. This pack
does not create access keys or claim that configuration certified. A native
Google Cloud SES-equivalent does not exist.

## Scaling and cost controls

- The API scales from zero to ten instances by default.
- The Worker Pool runs one instance continuously because PostgreSQL due rows
  and outbox recovery need a reconciler. Worker Pools do not autoscale.
- PostgreSQL pool maxima must be sized against Cloud SQL connection limits.
- `ZONAL` Cloud SQL can lower test cost; retain `REGIONAL` for the production
  default.
- Attachment objects expire after 30 days. Cloud Storage soft delete retains
  deleted objects for seven days by default.

Set `enable_pubsub_wakeup = true` to provision one topic and one pull
subscription. The API commits a deterministic PostgreSQL job first and then
best-effort publishes the fixed `hayasend_wakeup=1` attribute. It never
publishes message IDs, recipient addresses, subject/body content, attachments,
provider payloads, or customer metadata.

The worker performs bounded REST pulls through Application Default
Credentials, acknowledges each hint, and immediately leases PostgreSQL. A
timeout, malformed response, acknowledgment failure, duplicate, expired hint,
or Pub/Sub outage falls back to PostgreSQL polling. Delayed jobs are never
published to Pub/Sub; PostgreSQL due rows own the full 30-day schedule. The
accelerator defaults off and creates no Pub/Sub API or resource unless enabled.

## Rotation

Change the secret value and increment its matching monotonic version:

```bash
export TF_VAR_api_key="re_..."
export TF_VAR_api_key_version=2
./deploy.sh
```

Use `database_password_version` for a database password rotation. The new
Cloud Run revisions pin the newly created Secret Manager version. Increment
`sendgrid_secret_version` when either SendGrid key rotates.

## Cleanup

Deletion protection and bucket retention fail closed. For an explicitly
disposable deployment only:

```bash
export TF_VAR_deletion_protection=false
export TF_VAR_force_destroy_attachment_bucket=true
export TF_VAR_bucket_soft_delete_retention_seconds=0
export HAYASEND_ALLOW_DESTROY=cloud-run
./cleanup.sh
```

The cleanup script first applies the explicit deletion-protection and bucket
retention changes, then destroys the complete dependency graph. Required APIs
remain enabled by default so a deployment pack cannot disrupt a shared
project. Set
`disable_apis_on_destroy=true` only in a dedicated disposable project.

`cleanup.sh` now runs `verify-zero-residue.sh` after Terraform destroy. The
independent verifier queries Cloud Run services, jobs, and worker pools; Cloud
SQL; buckets; secrets; service accounts; VPC resources; Pub/Sub topics and
subscriptions; and HayaSend IAM bindings in the exact project. It fails closed
on query errors or residue and never prints secret values, addresses, message
content, provider payloads, database dumps, or attachment data.

## Official references

Checked on 2026-07-29:

- [Cloud Run resource model](https://docs.cloud.google.com/run/docs/resource-model)
- [Deploy Worker Pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools)
- [Pub/Sub pull subscriptions](https://docs.cloud.google.com/pubsub/docs/pull)
- [Pub/Sub REST publish](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/publish)
- [Pub/Sub REST pull](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/pull)
- [Pub/Sub IAM roles](https://docs.cloud.google.com/iam/docs/roles-permissions/pubsub)
- [Cloud Run and Cloud SQL for PostgreSQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
- [Cloud Run Direct VPC](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)
- [Worker Pool secrets](https://docs.cloud.google.com/run/docs/configuring/workerpools/secrets)
- [Cloud Storage V4 signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signing-urls-with-helpers)
- [Google Terraform provider](https://registry.terraform.io/providers/hashicorp/google/latest)
