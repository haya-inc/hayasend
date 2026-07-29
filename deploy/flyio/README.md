# Fly.io deployment pack

This experimental pack binds HayaSend's shared `portable-postgres` runtime to:

- one Fly App with separate API and continuously running worker process groups;
- Fly.io Managed Postgres;
- one private Tigris S3-compatible bucket; and
- Fly secrets for the API key, database URL, and bucket credentials.

The pack starts with the non-sending `console` transport so runtime lifecycle
proofs cannot accidentally submit mail. Fly.io has no native
transactional-email service; the signed SendGrid HTTP transport remains an
explicit second-phase option. The pack remains an implementation starting
point, not a Beta or production-readiness claim.

## Pinned inputs

Validated on 2026-07-29 with:

- `flyctl 0.4.75`;
- HayaSend `0.3.1` OCI index digest
  `sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979`;
- its Linux/amd64 manifest digest
  `sha256:79a2e9221ad8e395490cf342be9247f5c92013cd5657cdb1dbe7910392567ec6`;
- the latest Fly.io Managed Postgres major accepted by that CLI, PostgreSQL
  `17`; and
- the Tokyo Fly region `nrt`.

Repository CI verifies the Linux x86_64 release archive against GitHub's
published SHA-256 digest, checks the installed command surface, statically
validates the reviewed `fly.toml`, verifies its recorded Linux/amd64 manifest
against the live immutable OCI index, and ShellChecks every lifecycle script.
The authenticated deploy path additionally runs `fly config validate
--strict`.

Fly Managed Postgres does not yet expose PostgreSQL 18. That version gap is
explicit: HayaSend's PostgreSQL 18 CI remains the primary substrate proof,
while the hosted Fly composition must separately pass the same conformance
catalog on PostgreSQL 17.

## Resource names and cost guard

Choose a globally unique app name beginning with `hayasend-flyio-`. The pack
derives two exact names:

- Managed Postgres: `<app>-mpg`
- Tigris bucket: `<app>-attachments`

Provisioning creates billable resources. Review current Fly.io and Tigris
pricing, choose a Managed Postgres plan explicitly, and use only an isolated
test app:

```bash
export HAYASEND_FLY_APP="hayasend-flyio-example"
export HAYASEND_FLY_ORG="your-org"
export HAYASEND_FLY_MPG_PLAN="basic"
export HAYASEND_API_KEY="re_$(openssl rand -hex 32)"
export HAYASEND_TRANSPORT="console"
export HAYASEND_FLY_CREATE="confirmed"
./provision.sh
```

`provision.sh` refuses an existing app, database name, or bucket. Fly's
Managed Postgres create command currently prints a connection URI and Tigris
prints access keys. The script captures that output in a mode-700 temporary
directory, never echoes it, overwrites the temporary files, and removes the
directory. The resulting values are available only as encrypted Fly secrets;
`fly secrets list` returns names and digests, not values.

Store the API key in an operator password/secrets system. If operators need
direct bucket access for backup or cleanup evidence, create a separately
scoped Tigris key in the Tigris console instead of trying to recover the
application secret.

Record the non-secret Managed Postgres cluster ID printed at the end:

```bash
export HAYASEND_FLY_MPG_CLUSTER_ID="replace-with-exact-id"
export HAYASEND_FLY_BUCKET="${HAYASEND_FLY_APP}-attachments"
```

## Deploy and verify

Export the reviewed immutable image and deploy:

```bash
export HAYASEND_IMAGE="ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979"
export HAYASEND_FLY_MACHINE_IMAGE_DIGEST="sha256:..."
./deploy.sh
```

Fly can mirror an external image under a Fly Registry deployment tag, so the
Machine's `config.image` string is not a reliable copy of the original GHCR
reference. Derive and independently record the Linux/amd64 child manifest
from the reviewed OCI index before deployment. For example, with a current
Docker Buildx installation:

```bash
docker buildx imagetools inspect --raw "$HAYASEND_IMAGE" |
  jq --raw-output '
    [
      .manifests[] |
      select(
        .platform.os == "linux" and
        .platform.architecture == "amd64"
      )
    ] |
    if length == 1 then .[0].digest else error("ambiguous manifest") end
  '
```

The shipped `0.3.1` value is also recorded in
`.image-linux-amd64-sha256`. `verify.sh` requires both process groups to
report that exact runtime digest through the Machine API, the official
HayaSend OCI source/title labels, and one shared non-empty Fly image
reference.

The config uses:

- `release_command = "node dist/portable/migrate.js"` before Machine updates;
- an API process running `node dist/server.js`;
- a worker process running `node dist/portable/worker.js`;
- the default rolling strategy;
- no application-attached volume;
- one always-on API Machine and one always-on worker Machine for the initial
  experimental proof;
- `/readyz` Fly health checks; and
- the canonical new-code Tigris endpoint `https://t3.storage.dev`.

`deploy.sh` passes the reviewed `HAYASEND_TRANSPORT` explicitly on every
deployment and rollback. When omitted it resolves to `console`, matching the
committed `fly.toml`, and also passes the exact
`HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending` guard. An operator cannot
replace that guard with a lookalike value, and SendGrid deployments omit it.

Run the
[shared portable hosted proof](https://github.com/haya-inc/hayasend/blob/main/docs/portable-hosted-proof.md)
from an approved private path after the API and worker pass inventory checks.
It validates the database-owned long schedule and lost-wake-up recovery but
does not substitute for the separate Fly backup, rollback, or delivery gates.

`--ha=false` makes initial cost and inventory deterministic. It is not an HA
claim. Before promotion, size and prove multiple API and worker Machines,
regional placement, connection-pool totals, worker lease takeover, and failure
recovery.

`verify.sh` fails unless:

- exactly one named app exists in the selected organization;
- exactly one ready Managed Postgres cluster is attached only to that app;
- exactly one active private Tigris bucket is attached to that app;
- all required secret names exist with exact `Deployed` status;
- exactly one started API Machine and one started worker Machine use the
  expected immutable image and have no volumes;
- every reported Fly health check passes; and
- `/healthz` and `/readyz` respond successfully over HTTPS.

The default API origin is:

```text
https://<app>.fly.dev
```

Custom-domain certificates and DNS are a separate hosted acceptance step.
After the console-only lifecycle and recovery proof passes, opt in to the
separately approved transport phase by provisioning with:

```bash
export HAYASEND_TRANSPORT="sendgrid"
export SENDGRID_API_KEY="SG...."
export SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY="..."
```

Configure SendGrid's Signed Event Webhook URL as
`https://<app>.fly.dev/events/sendgrid` and enable processed, deferred,
delivered, bounce, dropped, spamreport, open, and click events.

## Storage boundary

Tigris is private by default, S3-compatible, globally placed, and integrated
with Fly secrets. HayaSend uses the canonical endpoint, region `auto`, virtual
host addressing, checksum-bound presigned uploads, and final byte-level
SHA-256 verification before provider submission.

Buckets created by `fly storage create` do **not** have Tigris snapshots
enabled. Snapshots must be enabled when a bucket is created and cannot be
enabled later. Production evaluation therefore needs one of:

- a new snapshot-enabled bucket created with the authenticated Tigris CLI,
  followed by migration and a restore/fork drill; or
- an independently proven shadow/write-through or backup destination.

Cross-region caching/replication is not a substitute for a recoverable
point-in-time backup. Do not promote this pack until database plus object
storage restoration produces the same ledger/payload state and recovers due
work without an external send.

Tigris credentials occupy the standard AWS credential variables for S3.
They are storage credentials, not Amazon SES credentials.

## Managed Postgres boundary

Fly.io describes Managed Postgres as providing automatic backups and recovery,
high availability with automatic failover, private networking, monitoring,
scaling, and encryption at rest and in transit. Those provider statements are
not HayaSend evidence by themselves. A hosted proof must exercise backup
creation/listing, isolated restore, connection cutover, ledger integrity, and
due-work recovery.

Current Fly documentation also lists security patches and version upgrades as
still under development. Treat engine upgrade and major-version migration as
open operational blockers, and record the exact plan, retention, recovery
window, replica count, and support terms observed during the proof.

## Rollback

Fly.io rollback is a deployment of a previous image, not database time travel.
Use a reviewed GHCR digest so rollback does not depend on Fly registry
retention:

```bash
export HAYASEND_ROLLBACK_IMAGE="ghcr.io/haya-inc/hayasend@sha256:..."
export HAYASEND_ROLLBACK_MACHINE_IMAGE_DIGEST="sha256:..."
./rollback.sh
```

The script uses a rolling deployment and deliberately skips the release
command. The database remains on its forward-compatible additive schema.
Fly configuration and secrets also remain current. Prove that the immediately
previous application revision works against that schema before relying on
rollback.

## Transport boundary

`HAYASEND_TRANSPORT=console` is the fail-closed lifecycle default.
`HAYASEND_TRANSPORT=sendgrid` submits through the SendGrid v3 Mail Send API
only after the scoped API key and verification key are supplied. Only opaque
HayaSend correlation values enter custom arguments, and the public ingress
verifies the exact raw body with SendGrid's ECDSA signature.
Deployment success, HTTP 202, `processed`, or a running worker is not terminal
delivery evidence. Hosted proof remains tracked in issue #150.

## Cleanup

First delete every object and use an authenticated S3 `ListObjectsV2` against
the exact bucket to prove zero objects. Then set all guards:

```bash
export HAYASEND_ALLOW_DESTROY="flyio"
export HAYASEND_FLY_DEDICATED_APP="true"
export HAYASEND_FLY_TIGRIS_EMPTY="true"
./cleanup.sh
```

The final flag is an operator attestation backed by the separate authenticated
zero-object result; `flyctl storage status` does not expose an object count.
The script independently verifies the exact app, only-attached database,
private bucket, secret names, immutable image, two process groups, and absence
of Machine volumes before deletion. It destroys the empty bucket first, the
app second, and Managed Postgres last, then requires all three names/IDs to be
absent from active inventory.

Also verify custom domains/certificates, separately created Tigris keys,
snapshot forks, retained database backups, organization tokens, and billing.
The script cannot prove deletion of resources created outside its exact
inventory.

## Promotion gates

Keep the Fly.io composition experimental until an isolated hosted run proves:

- PostgreSQL 17 conformance parity;
- queue-loss, process-loss, and 30-day due-row recovery;
- upgrade and compatible application rollback;
- Managed Postgres failover and isolated restore;
- Tigris snapshot/backup restore and payload integrity;
- multi-Machine API/worker behavior and capacity;
- an exact external transport with terminal recipient evidence; and
- zero active and retained residue with a billing check.

## GitHub-hosted console proof

`.github/workflows/flyio-integration.yml` is a manual-only proof-and-delete
workflow on protected `main`. Provision the exact isolated app, Managed
Postgres cluster, and private Tigris bucket with the reviewed pack first, then
configure the `flyio-integration` GitHub environment with:

- exact `FLY_TEST_APP`, `FLY_TEST_ORG`, `FLY_TEST_MPG_CLUSTER_ID`, and
  `FLY_TEST_BUCKET`;
- `FLY_TEST_ACCOUNT_KIND=general-purpose-test`;
- `FLY_TEST_REGION=nrt`;
- `FLY_TEST_TOKEN_SCOPE=dedicated-test-org`;
- `FLY_TEST_MPG_PLAN=basic`;
- `FLY_TEST_MPG_STORAGE_GB=10`;
- `FLY_TEST_COST_CEILING_USD=50`;
- `FLY_TEST_DURATION_MINUTES=60`;
- `FLY_TEST_ACCOUNT_EMAIL`; and
- a dedicated-organization `FLY_API_TOKEN` environment secret.

Dispatch must repeat the exact app name and proposed USD 50 ceiling. The
workflow verifies the deployed two-Machine topology and immutable amd64 image,
runs the PostgreSQL 17 semantic proof in a separately named disposable
Machine, destroys that Machine even after failure, inventories the private
bucket through the application's scoped Tigris credentials, and deletes the
bucket, app, and attached Managed Postgres cluster only after zero-object
evidence. It does not configure SendGrid or send mail. It is implemented and
locally validated, but has not yet been executed.

## Official references

- [Install flyctl](https://fly.io/docs/flyctl/install/)
- [App configuration](https://fly.io/docs/reference/configuration/)
- [Deploy an app](https://fly.io/docs/launch/deploy/)
- [Process groups](https://fly.io/docs/launch/processes/)
- [Rollback guide](https://fly.io/docs/blueprints/rollback-guide/)
- [Managed Postgres](https://fly.io/docs/mpg/)
- [Tigris object storage](https://fly.io/docs/tigris/)
