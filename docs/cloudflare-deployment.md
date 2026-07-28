# Cloudflare Beta deployment

HayaSend can deploy a Beta proof runtime to Cloudflare Workers with D1, R2,
Queues, a dead-letter queue, cron reconciliation, and the Email Sending
binding. It exposes the unchanged Resend-shaped send, batch, get, and list
surface plus privacy-safe HayaSend recipient summaries. It is not
production-ready and must not receive critical traffic.

## Account boundary

Use a reusable general-purpose **test account that is dedicated to disposable
integration workloads**. A new account is not required for every run. Do not
run the lifecycle proof in an account containing production or staging
resources: cleanup intentionally deletes the deterministic resources created
for the selected deployment name.

The account must have:

- Workers Paid, because outbound Email Sending is a Beta paid-plan feature;
- an enabled Email Sending domain and a controlled sender under that domain;
- one controlled, Cloudflare-verified recipient whose owner has consented to
  test mail;
- a Workers subdomain;
- an API token restricted to that account and only the Worker Scripts, D1, R2,
  Queues, and Email Sending write/read capabilities needed by the lifecycle;
  and
- no unrelated data in any `hayasend-<name>-*` resource selected for a test.

Prefer a dedicated API token over an interactive OAuth token. Rotate it after
suspected exposure and never pass it as a CLI argument.

## Plan, deploy, inspect, and remove

Pin an exact released HayaSend version in automation:

```bash
HAYASEND_VERSION=X.Y.Z
ACCOUNT_ID=0123456789abcdef0123456789abcdef
DEPLOYMENT_NAME=proof
EMAIL_DOMAIN=example.com

npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  deploy cloudflare \
  --account "$ACCOUNT_ID" \
  --name "$DEPLOYMENT_NAME" \
  --email-domain "$EMAIL_DOMAIN"
```

The default is a read-only JSON plan. It records the exact HayaSend, Node, npm,
Wrangler, compatibility-date, provider capability digest, deterministic
resource names, mutations, and Beta truth.

Apply only after checking the authenticated account and the plan. Secrets come
from the process environment and are written only to a mode-`0600` temporary
file that the CLI removes:

```bash
export CLOUDFLARE_API_TOKEN='...'
export HAYASEND_CLOUDFLARE_API_KEY='re_...'

npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  deploy cloudflare \
  --account "$ACCOUNT_ID" \
  --name "$DEPLOYMENT_NAME" \
  --email-domain "$EMAIL_DOMAIN" \
  --deployment-id reviewed-proof-1 \
  --allowed-recipient controlled-recipient@example.net \
  --confirm-account "$ACCOUNT_ID" \
  --apply
```

Apply requires one or more Cloudflare-verified `--allowed-recipient` values and
writes them to the Email Sending binding's
`allowed_destination_addresses`; the proof cannot send to any other address.
It also requires the exact enabled Email Sending `--email-domain`. The deploy
result records the supported Cloudflare Dashboard handoff for that domain.
It creates one D1 database, one private R2 bucket, three Queues, and one Worker.
It applies additive D1 migrations with Cloudflare's pre-migration backup,
uploads a tagged Worker version, and routes 100% of traffic to that explicit
version. The provider is selected by deployment configuration; application
send code remains unchanged.

Run `doctor` against the stable Workers endpoint
`https://hayasend-<name>.<account-subdomain>.workers.dev` (the hosted workflow
constructs this from its reviewed account subdomain):

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  doctor cloudflare \
  --endpoint "$HAYASEND_BASE_URL" \
  --deployment-id reviewed-proof-1
```

Doctor verifies health, deployment identity, capability digests, the explicit
Beta/non-production claim, and the authenticated email API.

Upgrade by reusing the returned D1 database ID:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  upgrade cloudflare \
  --account "$ACCOUNT_ID" \
  --name "$DEPLOYMENT_NAME" \
  --email-domain "$EMAIL_DOMAIN" \
  --database-id "$DATABASE_ID" \
  --deployment-id reviewed-proof-2 \
  --allowed-recipient controlled-recipient@example.net \
  --confirm-account "$ACCOUNT_ID" \
  --apply
```

Rollback always targets a reviewed immutable version ID:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  rollback cloudflare \
  --account "$ACCOUNT_ID" \
  --name "$DEPLOYMENT_NAME" \
  --version-id "$VERSION_ID" \
  --confirm-account "$ACCOUNT_ID" \
  --apply
```

Cleanup is plan-first and deletes only the deterministic resource set. On
apply it removes the Worker first, reads HayaSend-owned payload references,
deletes private R2 payloads, then deletes the bucket, Queues, and D1 database:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  cleanup cloudflare \
  --account "$ACCOUNT_ID" \
  --name "$DEPLOYMENT_NAME" \
  --confirm-account "$ACCOUNT_ID" \
  --apply
```

Do not treat the cleanup command alone as proof. List D1, R2, Queues, and
Worker versions afterward and fail closed if the absence check itself cannot
be completed.

## Backup and isolated restore

The D1 ledger and its retained R2 payload objects form one logical backup.
Backing up only D1 leaves dangling `payload_ref` values; copying R2 objects
without their HayaSend custom metadata and SHA-256 checksum makes restored
payloads fail closed.

The protected `Cloudflare integration` workflow therefore performs this
combination drill inside the approved general-purpose test account:

1. persist one provider-accepted fixture and one future-due fixture;
2. add a clearly labeled synthetic terminal event used only to exercise
   restore semantics, never as provider-delivery evidence;
3. export D1 with `wrangler d1 export`;
4. copy every managed R2 object to a separate private bucket while preserving
   HTTP metadata, custom metadata, size, and SHA-256;
5. import the SQL into a separately named D1 database;
6. require the restored D1+R2 state digest to equal the source digest;
7. hydrate every restored delivery ledger and require an empty
   `PRAGMA foreign_key_check`;
8. make the restored future-due outbox item executable, publish it to an
   unconsumed proof Queue exactly once, and prove a second reconciliation is
   empty;
9. verify the message, recipient, attempt, and provider-event ledger did not
   change during recovery; and
10. delete both namespaces and verify no named Worker, D1 database, R2 bucket,
    or Queue remains.

The SQL export and payload contents stay in the ephemeral runner and are never
uploaded as workflow evidence. Published evidence contains only counts,
checksums, pass/fail fields, tool versions, and cleanup results. The standalone
Wrangler R2 object commands are not treated as a complete backup mechanism
because they do not expose all HayaSend custom-metadata preservation controls.

The drill passed on exact protected `main` commit
`6158bec037f9d9aedf06871e445644d7f46fd58d` in
[hosted run 30350436333](https://github.com/haya-inc/hayasend/actions/runs/30350436333).
The source and restored combined state digests matched, relational and payload
integrity passed, the first due-work sweep dispatched once, the second
dispatched nothing, and the final residue check found no named proof resource.
The synthetic terminal event in this drill is restore-only evidence and does
not satisfy issue #122's provider-delivery gate. The source commands are
documented by Cloudflare in
[D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and
[R2 Workers bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Hosted integration environment

The manual `Cloudflare integration` GitHub Actions workflow uses the protected
`cloudflare-integration` environment. Configure:

| Type     | Name                                | Meaning                           |
| -------- | ----------------------------------- | --------------------------------- |
| Variable | `CLOUDFLARE_TEST_ACCOUNT_ID`        | Exact approved test account ID    |
| Variable | `CLOUDFLARE_TEST_ACCOUNT_KIND`      | Literal `general-purpose-test`    |
| Variable | `CLOUDFLARE_TEST_WORKERS_SUBDOMAIN` | Account Workers subdomain         |
| Variable | `CLOUDFLARE_TEST_EMAIL_DOMAIN`      | Enabled Email Sending domain      |
| Variable | `CLOUDFLARE_TEST_FROM`              | Controlled enabled sender         |
| Variable | `CLOUDFLARE_TEST_TO`                | Controlled, verified recipient    |
| Secret   | `CLOUDFLARE_API_TOKEN`              | Account-scoped lifecycle token    |
| Secret   | `HAYASEND_CLOUDFLARE_API_KEY`       | Strong `re_`-prefixed runtime key |

The dispatcher must re-enter the exact account ID. The workflow refuses a
mismatch or an environment that is not explicitly marked as the approved
general-purpose test account. It also proves the run-specific HayaSend
namespace is unused before deployment. Cleanup and residue checks do not run
unless the account guard passed, preventing a failed confirmation from
authorizing deletion while preserving unrelated test resources.

The workflow records pinned tools, plan, deployment result, doctor output,
official Resend SDK send/retrieval, isolated backup/restore proof, controlled
health failure, explicit rollback, cost estimate, cleanup, and fail-closed
absence checks as a retained artifact.

## Email Sending event subscription and terminal proof

Cloudflare documents six per-domain Email Sending events—delivered, deferred,
bounced, failed, rejected, and complained—and the HayaSend consumer supports
their current schema. Wrangler 4.114.0 can list, inspect, and delete these
subscriptions, but its creation command does not expose the Email Sending
domain selector. Create the subscription through Cloudflare's documented
Dashboard surface after the retained deployment creates its Queue:

1. Open **Queues**, select `hayasend-<name>-email-events`, and open
   **Subscriptions**.
2. Choose **Subscribe to events**, source **Email Sending**, the exact reviewed
   domain, and all six events.
3. Verify the control plane before sending:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" \
  doctor cloudflare-events \
  --account "$ACCOUNT_ID" \
  --name "$DEPLOYMENT_NAME" \
  --email-domain "$EMAIL_DOMAIN"
```

The manual `Cloudflare terminal delivery` workflow implements this two-phase
boundary. Its `deploy` phase retains an isolated namespace for the Dashboard
handoff. After the subscription exists, `verify-and-cleanup` sends a uniquely
identified message with the official Resend SDK, requires the aggregate and
recipient records to reach `delivered`, requires exactly one correlated
terminal `delivered` provider event in D1, and then removes the subscription
and every retained resource. Provider acceptance or a HayaSend `sent` status
alone is not delivery proof. Confirm the unique subject in the controlled
recipient mailbox, including spam and trash, before accepting the evidence.

The proof retries a timed-out SDK submission with the same idempotency key, so
an edge response loss cannot create a second HayaSend record. It also tolerates
transient retrieval failures while retaining the last safe aggregate and
recipient observation in the workflow artifact. A missing terminal event,
non-transient API error, or exhausted deadline still fails closed.

## Beta limitations

- Cloudflare Email Sending itself is Beta and account quotas adapt over time.
- The proof exposes send, batch send, get, list, and privacy-safe recipient
  summaries only.
- Hosted templates, uploaded attachment references, domain management,
  webhooks, inbound email, open/click events, and provider-side idempotency are
  unavailable.
- Inline canonical-base64 attachments must fit HayaSend's 5 MiB total-message
  preflight.
- A provider acceptance followed by a crash before the attempt update remains
  an explicit duplicate-send ambiguity.

Use the [Cloudflare cost model](cloudflare-costs.md) and
[provider capability document](provider-capabilities.md) with every hosted
proof.
