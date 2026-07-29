# CLI guide

The HayaSend CLI provides non-interactive building blocks for local setup,
connectivity checks, hosted-template delivery, and end-to-end send
verification. Run released commands with an exact version:

```bash
HAYASEND_VERSION=X.Y.Z
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" help
```

Pin the version in scripts and CI. Do not depend on the mutable `latest`
dist-tag for infrastructure operations. The CLI package is also attached to
the corresponding GitHub release, covered by its checksums and attestation.

Contributors can run the same CLI from a source checkout:

```bash
npm run cli -- help
```

Every command, including `deploy aws`, runs without a source checkout. AWS
deployment uses only the reviewed SAM template and Lambda source shipped in
that exact package version; it never discovers infrastructure code from the
caller's working directory.

Cloudflare lifecycle commands likewise use the Worker source and D1 migrations
shipped in that exact package. See
[Cloudflare Beta deployment](cloudflare-deployment.md) for the dedicated
account, secrets, rollback, cleanup, and hosted evidence boundary.

## Initialize local development

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" init \
  --dir ../my-application
```

`init` creates exactly two files:

- `compose.hayasend.yaml`, pinned to the CLI's exact HayaSend version and
  hardened with a loopback port, read-only filesystem, no Linux capabilities,
  and `no-new-privileges`;
- `.env.hayasend.example`, containing the local API URL and development-only
  key expected by the official Resend SDK or direct HTTP clients.

The command checks every target first. If either file already exists, it writes
nothing and reports the conflicts. It never edits an application's existing
`.env`, `.gitignore`, dependency manifest, or source.

## Manage least-privilege API keys

Use the bootstrap administrator key only while issuing scoped application
keys. Pass it through the environment, never as a command-line argument:

```bash
HAYASEND_API_KEY="$HAYASEND_BOOTSTRAP_KEY" \
  npm run --silent cli -- keys create \
    --name "production transactional sender" \
    --scope emails:send \
    --scope emails:read \
    --token-out ./hayasend-production-sender.token
```

`--scope` is repeatable and accepts `emails`, `templates`, `domains`,
`webhooks`, `suppressions`, or `api_keys` with a `:read` or `:write` suffix,
except that email delivery uses `emails:send`. The read-only
`diagnostics:read` scope grants access to aggregate recovery evidence. Add
`--expires-at` with the workload's next rotation deadline when the key must
expire; it must be a future UTC date-time.

`--token-out` is required. The CLI reserves the path before contacting
HayaSend, creates it with mode `0600`, refuses an existing path, and removes
the empty file if the API request fails. The one-time token is never printed
or included in the command's JSON metadata. Import the file into an approved
secret manager and remove the local copy. If the process is forcibly
interrupted after the API accepts the request, use `keys list` to find and
revoke any unused key.

Manage metadata and revocation without exposing token material:

```bash
npm run --silent cli -- keys list --limit 20
npm run --silent cli -- keys get key_0123456789abcdef0123456789abcdef
npm run --silent cli -- keys revoke key_0123456789abcdef0123456789abcdef
```

`create` and `revoke` require `api_keys:write`; `list` and `get` require
`api_keys:read`. A scoped key cannot grant permissions that it does not
already hold. Tokens are never returned by list or get.

Start the generated service from the application directory:

```bash
docker compose -f compose.hayasend.yaml up -d
```

## Diagnose a deployment

Keep API keys out of shell history and process listings:

```bash
export HAYASEND_BASE_URL=http://localhost:8787
export HAYASEND_API_KEY=re_hayasend_dev
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" doctor
```

`doctor` has a five-second timeout and checks:

1. the health endpoint returns JSON identifying the service as HayaSend;
2. the key can read the email endpoint;
3. privacy-safe outbox age, stuck-lease, queue/DLQ, provider-event lag, and
   capability evidence for the in-memory, AWS SQS, or portable PostgreSQL
   runtime when the key has `diagnostics:read`;
4. whether the running transport, runtime substrate, and exact
   runtime-plus-transport deployment digests match this CLI package, including
   cross-checking the deployment's declared runtime and provider;
5. whether the local preview is available.

Without `diagnostics:read`, the recovery check reports `not_authorized`
without failing the existing health and authentication checks. It never prints
the API key, addresses, subject or body content, signed URLs, raw provider
errors, or unrecognized server fields. HTTPS is required unless the endpoint
is `localhost`, `127.0.0.1`, or `[::1]`; endpoint credentials, queries, and
fragments are rejected.

Older servers may omit the additive `runtime_capability` and
`deployment_capability` objects. Bundled deployments report them: an unknown
customer extension produces `drift: null`, while any changed bundled document
or inconsistent runtime/provider binding produces `drift: true`.

## Onboard a sending domain

Register an isolated sending subdomain and inspect the returned DNS records:

```bash
npm run cli -- domains create --name mail.example.com
npm run cli -- domains list --limit 20
npm run cli -- domains get dom_0123456789abcdef0123456789abcdef
npm run cli -- domains verify dom_0123456789abcdef0123456789abcdef
```

Create, verify, and delete require `domains:write`; list and get require
`domains:read`. `verify` refreshes SES state once. It does not edit DNS, send
mail, or poll. Deletion removes the SES identity and requires an explicit
acknowledgement:

```bash
npm run cli -- domains delete \
  dom_0123456789abcdef0123456789abcdef --yes
```

See [sending-domain onboarding](domain-onboarding.md) for the DKIM workflow,
DMARC boundary, canary gate, and DNS cleanup guidance.

## Send an end-to-end test

The `test` command creates a message and retrieves its record:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" test \
  --from 'Product <sender@example.com>' \
  --to recipient@example.net \
  --subject 'HayaSend integration test'
```

This is a real send when the endpoint is an AWS deployment. Use only addresses
you are authorized to contact. In local mode no message leaves the process, and
the result includes a direct URL to the preview. Both send commands read the
endpoint and key from the environment and accept `--endpoint` as a non-secret
override.

## Send production-shaped email

`emails send` exposes the API's non-interactive transactional surface:

```bash
npm run cli -- emails send \
  --from 'Product <sender@example.com>' \
  --to first@example.net second@example.net \
  --cc manager@example.com \
  --bcc archive@example.com \
  --reply-to support@example.com \
  --subject 'Your invoice' \
  --html-file ./invoice.html \
  --text-file ./invoice.txt \
  --attachment ./invoice.pdf \
  --header X-Correlation-ID=order-123 \
  --tag category=transactional \
  --scheduled-at 'in 10 minutes' \
  --idempotency-key invoice-order-123
```

`--to`, `--cc`, `--bcc`, `--reply-to`, `--attachment`, `--header`, and
`--tag` accept one or more values and may be repeated. Direct messages require
`--from`, `--subject`, at least one `--to`, and at least one HTML or text body.
Use `--html`/`--text` for inline content or
`--html-file`/`--text-file` for files; each inline/file pair is mutually
exclusive, while HTML and text may be supplied together. The root-level
`hayasend send` spelling remains an alias.

Use `-` for exactly one body on standard input:

```bash
render-email | npm run cli -- emails send \
  --from sender@example.com \
  --to recipient@example.net \
  --subject 'Rendered email' \
  --html-file -
```

Standard input and body files must be non-empty UTF-8. Files are resolved, then
read from a bounded regular-file descriptor so a pathname cannot be swapped
between the size check and read. Each body source and the complete serialized
request are limited to 9 MiB. Prefer files or stdin over inline bodies because
arguments can be visible in shell history and process listings. Recipient
addresses, subject, header/tag values, file paths, and the idempotency key are
also command-line metadata; do not put secrets in them.

Attach up to 20 local regular files with an aggregate decoded size of 25 MiB.
The CLI reads and hashes every file before contacting HayaSend, declares its
basename, inferred media type, size, and SHA-256, verifies the returned upload
contract, uploads each file without the API key, and only then creates the
email with opaque attachment IDs. It rejects remote paths and stdin
attachments. If a later upload fails, no email is created; an earlier
successful but unreferenced upload expires under the normal 24-hour attachment
TTL. Retrying the complete command with the same idempotency key uploads fresh
attachment objects, but HayaSend compares their verified content hashes and
returns the original email ID; those unreferenced retry objects also expire
after 24 hours.

Scheduling accepts the same ISO 8601 and `in N minutes/hours/days` values as
the API. The CLI rejects past times and times beyond 30 days before sending,
then submits canonical UTC. `--idempotency-key` is sent only as the
`Idempotency-Key` header and is never printed. Custom headers use
`--header NAME=VALUE`; envelope/MIME headers remain HayaSend-managed. Tags use
`--tag NAME=VALUE`.

Send a published hosted template without message bodies:

```bash
npm run cli -- emails send \
  --to recipient@example.net \
  --template welcome \
  --var NAME=Ada \
  --var ORDER_ID=42
```

Template sends may still override `--from` and `--subject` and attach files.
They cannot combine `--template` with HTML or text options. The CLI does not
execute React Email/TSX; render that through the official SDK, or publish a
reviewed hosted template. All sends require `emails:send`. Output contains only
the accepted opaque email ID.

## Manage and recover webhooks

Register a webhook without exposing its one-time signing secret in terminal
output or CI logs:

```bash
mkdir -m 700 .secrets
npm run cli -- webhooks create \
  --url https://hooks.example.com/hayasend \
  --event email.sent \
  --event email.bounced \
  --secret-file .secrets/hayasend-webhook
```

`--url` is the receiving webhook URL; `--endpoint` remains the HayaSend API
override used by every remote CLI command. `--event` is repeatable and duplicate
values are removed. The CLI validates every event before contacting HayaSend.

`--secret-file` is required. Its parent directory must already exist and the
target must not: the CLI reserves the path with exclusive creation and mode
`0600` before registering the webhook. It writes the secret only after a valid
response, syncs it to disk, and prints the webhook metadata plus the absolute
file path—but never the secret. Unexpected secret-, token-, API-key-, or
authorization-like response fields are redacted recursively. A failed request
removes the empty reservation; a secret-write failure also attempts to delete
the newly created webhook. The recommended `.secrets/` directory is excluded
from Git and Docker build contexts; load the file into the receiving service's
secret manager.

Inspect and update endpoints with deterministic JSON output:

```bash
npm run cli -- webhooks list --limit 20
npm run cli -- webhooks get wh_0123456789abcdef0123456789abcdef
npm run cli -- webhooks update wh_0123456789abcdef0123456789abcdef \
  --status disabled
npm run cli -- webhooks update wh_0123456789abcdef0123456789abcdef \
  --url https://hooks.example.com/hayasend-v2 \
  --event email.sent \
  --event email.bounced \
  --status enabled
npm run cli -- webhooks delete wh_0123456789abcdef0123456789abcdef --yes
```

Deletion requires `--yes` because it permanently removes the endpoint.
Creating, updating, deleting, or replaying needs `webhooks:write`; listing and
inspection need `webhooks:read`.

Retained delivery history makes incident recovery scriptable:

```bash
npm run cli -- webhooks deliveries \
  wh_0123456789abcdef0123456789abcdef --limit 20
npm run cli -- webhooks inspect-delivery \
  wh_0123456789abcdef0123456789abcdef msg_0123456789abcdef0123456789abcdef
npm run cli -- webhooks replay \
  wh_0123456789abcdef0123456789abcdef msg_0123456789abcdef0123456789abcdef --yes
```

Replay queues a new delivery linked by `replayed_from` and is externally
observable, so it also requires `--yes`. Fix and re-enable the endpoint first,
then verify that the consumer deduplicates `svix-id`. Delivery history can
contain recipient and subject metadata; keep command output out of public
tickets and general-purpose analytics.

## Manage suppressions safely

Add a manual suppression before sending or migration traffic:

```bash
npm run cli -- suppressions add blocked@example.net
```

For production operations, keep the mailbox and any controlled audit reference
out of shell history and process listings:

```bash
npm run cli -- suppressions add \
  --email-file /secure/path/recipient.txt \
  --detail-file /secure/path/audit-reference.txt
```

The email file must be a regular file of at most 1,024 bytes containing one
mailbox. Display-name syntax is accepted and normalized to a lowercase mailbox.
The optional detail file is limited to 2,048 bytes and 500 characters after
trimming. Both inputs must be valid UTF-8 regular files; symbolic links are
rejected. Use only a bounded internal detail reference, not a message body,
support transcript, or other personal data. Operators cannot use the CLI to
create synthetic `bounce` or `complaint` entries: `add` always sends
`reason: manual`.

Inspect the list or one known mailbox:

```bash
npm run cli -- suppressions list --limit 20
npm run cli -- suppressions list \
  --after 8b279149185a9b8d7bd9fe5d66e194fb79be7dbce47296e0f58dc1b3d3311b20
npm run cli -- suppressions get --email-file /secure/path/recipient.txt
```

Every suppression command can print recipient addresses and controlled detail
references in its JSON response. Do not paste output into public issues, broad
log aggregation, or general-purpose analytics. `--after` accepts only the
64-character lowercase hexadecimal suppression ID returned by a preceding
page. List and get need `suppressions:read`; add needs `suppressions:write`.

Remove a suppression only after confirming that the recipient requested mail
and that the mailbox is valid:

```bash
npm run cli -- suppressions delete \
  --email-file /secure/path/recipient.txt \
  --yes
```

Deletion requires `--yes` and a key with `suppressions:write`. It changes only
HayaSend's application-level suppression record; it does not remove the
destination from the Amazon SES account-level suppression list.

## Inspect and control sent email

Use the lifecycle commands for canaries, support investigations, and queued
message recovery:

```bash
npm run cli -- emails list --limit 20
npm run cli -- emails list --after email_0123456789abcdef0123456789abcdef
npm run cli -- emails get email_0123456789abcdef0123456789abcdef
npm run cli -- emails recipients email_0123456789abcdef0123456789abcdef
```

`list` and `get` deliberately print an `email_summary`: opaque IDs, lifecycle
state, timestamps, safe provider/error categories, aggregate recipient and
attachment counts, and whether content exists. They omit sender and recipient
addresses, subject, bodies, headers, tags, attachment filenames, and any
unrecognized server fields. This makes the default output safer for terminals,
CI logs, and support transcripts, but it is still operational metadata and
should receive appropriate access controls.
`--after` accepts only the stable `email_` resource ID returned by a preceding
page.

`emails recipients` shows canonical per-recipient status, role, attempt state,
safe diagnostic category, ambiguity/retry state, and the deterministic message
aggregate. It uses opaque `rcpt_` IDs, supports `--limit` and
`--after RECIPIENT_ID`, and deliberately omits addresses, content, provider
message IDs, and unrecognized response fields. It requires `emails:read`.

When controlled debugging truly requires the stored message, opt in:

```bash
npm run cli -- emails get email_0123456789abcdef0123456789abcdef --include-content
```

That response can contain all recipients, subject, HTML and text bodies,
headers, tags, and attachment filenames. Do not redirect it into shared logs
or paste it into public issues.

Changing an accepted message requires a second acknowledgement:

```bash
npm run cli -- emails update email_0123456789abcdef0123456789abcdef \
  --scheduled-at 'in 10 minutes' \
  --yes
npm run cli -- emails cancel email_0123456789abcdef0123456789abcdef --yes
```

Rescheduling is limited to queued or scheduled email and to a time within 30
days. The CLI validates relative or ISO 8601 input locally and sends a
canonical UTC timestamp. Cancellation and rescheduling make no API request
without `--yes`. Read commands need `emails:read`; mutation commands need
`emails:send`.

## Manage templates as code

Keep a `hayasend.templates.json` manifest and its content files in the
application repository:

```json
{
  "$schema": "https://raw.githubusercontent.com/haya-inc/hayasend/main/schemas/hayasend.templates.schema.json",
  "version": 1,
  "templates": [
    {
      "alias": "welcome",
      "name": "Welcome",
      "html_file": "emails/welcome.html",
      "text_file": "emails/welcome.txt",
      "from": "Product <hello@example.com>",
      "subject": "Welcome, {{{NAME}}}",
      "reply_to": ["Support <support@example.com>"],
      "variables": [
        {
          "key": "NAME",
          "type": "string",
          "fallback_value": "friend"
        }
      ]
    }
  ]
}
```

Preview the reconciliation plan without making changes:

```bash
npm run cli -- templates push --dry-run
```

Push creates missing templates and updates drifted drafts. It reads and
validates the complete manifest and every referenced file before the first
write. Existing templates not present in the manifest are never deleted. An
unchanged template produces no write, which makes the command safe to rerun in
CI.

The default command never changes the version used by production sends. Review
the drafts and publish them with a second, explicit invocation:

```bash
npm run cli -- templates render welcome --var NAME=Ada
npm run cli -- templates push --publish
```

`--publish` promotes every created, updated, or already-unpublished draft in
the manifest. If a create or update succeeds but its publish fails, production
continues using the previous published snapshot; rerunning the same command
resumes reconciliation. Before each promotion, the CLI rereads the remote
draft, verifies that it exactly matches the manifest, and conditionally
publishes that version. A concurrent edit stops the command instead of
publishing unreviewed content. Use `--file PATH` for a differently named
manifest.

Aliases are mandatory because they are stable identities across deployments.
Content paths must be relative and resolve inside the manifest directory,
including through symlinks. The manifest is limited to 100 templates and 256
KiB; each content file is limited to 128 KiB. The checked-in
[JSON Schema](../schemas/hayasend.templates.schema.json) enables editor
completion, while the CLI repeats all validation before contacting HayaSend.
The repository includes a runnable
[example manifest](../examples/templates/hayasend.templates.json).

Inspect and promote an individual template with the Resend-shaped commands:

```bash
npm run cli -- templates list --limit 20
npm run cli -- templates get welcome
npm run cli -- templates render welcome --var NAME=Ada
npm run cli -- templates publish welcome \
  --version tmplv_0123456789abcdef0123456789abcdef
```

`render` evaluates the current draft with the production variable rules,
HTML escaping, header checks, output limits, and HTML-to-text conversion. It
returns HTML, text, rendered defaults, and the exact `version_id` without
queueing or sending an email. `publish --version` fails if that version is no
longer current. Omitting `--version` retains compatibility with ordinary
Resend-style publication, while managed workflows should always use it.

Use synthetic render variables: command-line values can be visible in shell
history and process listings. The render response can also contain the supplied
values.

The deployment key needs `templates:read` and `templates:write`. Keep those
scopes out of the application runtime key.

Inspect retained publications and recover one into a new draft:

```bash
npm run cli -- templates versions welcome --limit 20
npm run cli -- templates inspect-version welcome \
  tmplv_0123456789abcdef0123456789abcdef
npm run cli -- templates render-version welcome \
  tmplv_0123456789abcdef0123456789abcdef \
  --var NAME=Ada
npm run cli -- templates restore-version welcome \
  tmplv_0123456789abcdef0123456789abcdef
```

`versions` is newest-first and accepts `--after VERSION_ID`. Its output omits
template bodies. `inspect-version` returns the immutable retained content and
`render-version` applies the normal bounded rendering rules without sending.
`restore-version` first reads the current draft, then conditionally creates a
new draft from history. It neither changes the active published alias nor
publishes the restored content. Review with `templates render`, then use
`templates publish --version` when ready.

## Plan and deploy the Cloudflare Beta proof

The Cloudflare lifecycle is plan-first and requires an exact account
confirmation for every mutation:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" deploy cloudflare \
  --account 0123456789abcdef0123456789abcdef \
  --name proof \
  --email-domain example.com
```

After review, set `CLOUDFLARE_API_TOKEN` and a strong
`HAYASEND_CLOUDFLARE_API_KEY`, then add `--apply` and
`--confirm-account` with the identical account ID. Apply also requires at
least one repeatable `--allowed-recipient`; the deployed Email Sending binding
cannot send elsewhere. Every listed recipient must already be verified in the
Cloudflare account. `upgrade cloudflare` requires the existing D1 database ID
and the reviewed recipient allowlist and Email Sending domain. After deploying
a retained proof, create the documented per-domain Email Sending subscription
in the Cloudflare Dashboard, then run `doctor cloudflare-events` to require one
enabled subscription covering all six lifecycle events. `rollback cloudflare`
requires an immutable version ID. `cleanup cloudflare` first removes any event
subscription and then removes only the deterministic HayaSend resource set
after printing its deletion order.

Use only a reusable test account dedicated to disposable integration
resources, never an account with production or staging workloads. Full
commands and the protected GitHub environment contract are in
[Cloudflare Beta deployment](cloudflare-deployment.md); current rate inputs
are in [Cloudflare cost evidence](cloudflare-costs.md).

## Plan and deploy to AWS

Run the exact released CLI version from any working directory. The first
invocation is a non-mutating plan:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" deploy aws \
  --account 123456789012 \
  --region ap-northeast-1 \
  --stack hayasend
```

`--account` is required even when the AWS CLI already has credentials. The CLI
calls STS and stops before reading SES or CloudFormation if the authenticated
account differs. `--region` can instead come from `AWS_REGION` or
`AWS_DEFAULT_REGION`; `--profile` selects a named AWS profile.

The plan:

1. verifies the AWS, SAM, and npm CLIs;
2. reads caller identity, SES production/sending state and quota, and the
   existing CloudFormation stack;
3. refuses a stack that is not in a stable terminal state;
4. runs `sam validate --lint` and `sam build` in a temporary directory using an
   empty SAM configuration, so repository or user defaults cannot silently
   change the plan. A package-owned compatibility adapter removes only SAM's
   obsolete `--unsafe-perm` npm argument; all other arguments still reach the
   installed npm CLI unchanged, including npm 12's script allowlist checks;
5. prints the template SHA-256, effective parameters, tags, current stack
   state, and exact apply command as newline-delimited JSON. Plan mode emits
   one JSON object; apply mode emits one object per review or result event.
   Every event currently has `schema_version: 1`.

It makes no AWS writes. The principal ARN, account ID, resource ARNs, domains,
and stack outputs are not credentials, but they are still infrastructure
identifiers; do not paste plan output into a public issue.

Apply only after reviewing the plan:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" deploy aws \
  --account 123456789012 \
  --region ap-northeast-1 \
  --stack hayasend \
  --tag Environment=production \
  --apply
```

Apply performs another clean validation and build, uploads SAM artifacts, and
creates an unexecuted CloudFormation change set. It snapshots the existing
change-set IDs first, then accepts exactly one new ARN; concurrent deployment
activity causes a refusal. The CLI retrieves and prints the resource actions
for that ARN before execution.

Any removal, indeterminate `Dynamic` action, known or unknown replacement,
delete policy, or replace policy stops before execution. The unexecuted change
set remains available for inspection. If every destructive action is intended,
rerun the same inputs with both `--apply` and
`--allow-destructive-changes`. This is an explicit acknowledgement, not a way
to suppress the printed plan.

Existing stack parameters and non-AWS tags are carried forward unless the
command explicitly overrides them. Parameters removed from the current
template are not replayed. Supported overrides are:

- `--bootstrap-secret-arn ARN`;
- `--api-rate-limit 1..10000` (plain decimal values are accepted);
- `--api-burst-limit 1..5000` (integer);
- `--log-retention-days 1|3|5|7|14|30|60|90|120|150|180|365|400|545|731|1096|1827|2192|2557|2922|3288|3653`;
- `--enable-inbound` or `--disable-inbound`;
- `--inbound-recipient-suffixes @example.com,@example.org`;
- `--inbound-retention-days 1..30`;
- `--inbound-max-message-bytes 1..41943040`;
- `--inbound-tls-policy OPTIONAL|REQUIRED|FIPS`;
- `--webhook-retention-days 1..30`;
- `--template-history-retention-days 1..365`;
- `--template-history-limit 1..50`;
- `--worker-reserved-concurrency 0..1000` (`0` uses the account's unreserved
  concurrency pool);
- repeatable `--tag KEY=VALUE`.

Enabling inbound receiving requires explicit non-`.invalid` recipient
suffixes. An existing bootstrap secret ARN must belong to the expected account
and Region. `Project=HayaSend` and `ManagedBy=HayaSendCLI` tags are reserved.
The production default reserves 10 worker executions. New or quota-constrained
accounts can set the override to `0`; queue scaling still caps worker
concurrency at 10.

New stacks default to a best-effort HTTP API target of 10 requests per second
with a burst of 20. The CLI preserves configured values on updates. When it
first upgrades a stack created before these parameters existed, it carries
forward that stack's previous fixed behavior of 50 requests per second and a
burst of 100. Override both values in a reviewed plan if a different boundary
is intended.

Rate and burst are independent token-bucket inputs, not a monthly quota or
hard cost ceiling, and cannot exceed the account and Region's API Gateway
quota. API Gateway can return `429 Too Many Requests`; clients should retry
with exponential backoff and jitter and keep the same idempotency key for
create requests.

Lambda logs default to 30-day retention. The same parameter is visible in the
plan, carried forward on update, and used by the manual SAM workflow.

After execution, the CLI waits for CloudFormation, reads the API URL, bootstrap
secret ARN, alarm topic, dashboard, and optional inbound MX target, then prints
the next `hayasend doctor` step. It does not retrieve or print the bootstrap
secret and never creates DNS records. If CloudFormation fails, the error
includes redacted recent stack events for recovery. Follow the
[operations runbook](operations.md) before retrying.

## Send a hosted template

The CLI supports the same `--template` and repeatable `--var KEY=VALUE` shape
as the Resend CLI:

```bash
npm run cli -- send \
  --to person@example.net \
  --template welcome \
  --var NAME=Ada \
  --var ORDER_ID=42
```

Canonical safe integers such as `42` become number variables. Values with
leading zeroes such as `00123`, and all other values, remain strings. A
template send cannot be combined with `--text`; `--from` and `--subject` are
optional overrides of the published defaults.

## Scope

The beta CLI deliberately does not install dependencies or modify application
source. AWS deployment reuses the package's reviewed SAM template and ordinary
CloudFormation change sets; the reviewed manual SAM commands in the main
README remain a supported fallback. Migration automation remains on the
roadmap.
