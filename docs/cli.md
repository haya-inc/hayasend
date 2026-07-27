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

The package supports `init`, `dev`, `doctor`, `test`, `send`, and `templates`
without a source checkout. `deploy aws` currently requires a checkout because
SAM builds the checked-in TypeScript entry points; the CLI refuses a working
directory without `template.yaml`.

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
3. whether the local preview is available.

It never prints the API key. HTTPS is required unless the endpoint is
`localhost`, `127.0.0.1`, or `[::1]`; endpoint credentials, queries, and
fragments are rejected.

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
the result includes a direct URL to the preview.

The lower-level `send` command accepts `--from`, `--to`, `--subject`, and
`--text`. Both commands read the endpoint and key from the environment and
accept `--endpoint` as a non-secret override.

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

## Plan and deploy to AWS

Run the AWS workflow from a HayaSend checkout so SAM can build the reviewed
source tree. The first invocation is a non-mutating plan:

```bash
npm run cli -- deploy aws \
  --account 123456789012 \
  --region ap-northeast-1 \
  --stack hayasend
```

`--account` is required even when the AWS CLI already has credentials. The CLI
calls STS and stops before reading SES or CloudFormation if the authenticated
account differs. `--region` can instead come from `AWS_REGION` or
`AWS_DEFAULT_REGION`; `--profile` selects a named AWS profile.

The plan:

1. verifies the AWS and SAM CLIs;
2. reads caller identity, SES production/sending state and quota, and the
   existing CloudFormation stack;
3. refuses a stack that is not in a stable terminal state;
4. runs `sam validate --lint` and `sam build` in a temporary directory using an
   empty SAM configuration, so repository or user defaults cannot silently
   change the plan;
5. prints the template SHA-256, effective parameters, tags, current stack
   state, and exact apply command as newline-delimited JSON. Plan mode emits
   one JSON object; apply mode emits one object per review or result event.
   Every event currently has `schema_version: 1`.

It makes no AWS writes. The principal ARN, account ID, resource ARNs, domains,
and stack outputs are not credentials, but they are still infrastructure
identifiers; do not paste plan output into a public issue.

Apply only after reviewing the plan:

```bash
npm run cli -- deploy aws \
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

The alpha CLI deliberately does not install dependencies or modify application
source. AWS deployment reuses the checked-in SAM template and ordinary
CloudFormation change sets; the reviewed manual SAM commands in the main
README remain a supported fallback. Migration automation remains on the
roadmap.
