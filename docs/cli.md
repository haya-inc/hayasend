# CLI guide

The HayaSend CLI provides non-interactive building blocks for local setup,
connectivity checks, hosted-template delivery, and end-to-end send
verification. During the alpha it runs from a source checkout:

```bash
npm run cli -- help
```

The compiled package also exposes a `hayasend` executable so the same interface
can be distributed independently later without changing scripts.

## Initialize local development

```bash
npm run cli -- init --dir ../my-application
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
npm run cli -- doctor
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
npm run cli -- test \
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

## Inspect and control sent email

Use the lifecycle commands for canaries, support investigations, and queued
message recovery:

```bash
npm run cli -- emails list --limit 20
npm run cli -- emails list --after email_0123456789abcdef
npm run cli -- emails get email_0123456789abcdef
```

`list` and `get` deliberately print an `email_summary`: opaque IDs, lifecycle
state, timestamps, safe provider/error categories, aggregate recipient and
attachment counts, and whether content exists. They omit sender and recipient
addresses, subject, bodies, headers, tags, attachment filenames, and any
unrecognized server fields. This makes the default output safer for terminals,
CI logs, and support transcripts, but it is still operational metadata and
should receive appropriate access controls.

When controlled debugging truly requires the stored message, opt in:

```bash
npm run cli -- emails get email_0123456789abcdef --include-content
```

That response can contain all recipients, subject, HTML and text bodies,
headers, tags, and attachment filenames. Do not redirect it into shared logs
or paste it into public issues.

Changing an accepted message requires a second acknowledgement:

```bash
npm run cli -- emails update email_0123456789abcdef \
  --scheduled-at 'in 10 minutes' \
  --yes
npm run cli -- emails cancel email_0123456789abcdef --yes
```

Rescheduling is limited to queued or scheduled email and to a time within 30
days. The CLI validates relative or ISO 8601 input locally and sends a
canonical UTC timestamp. Cancellation and rescheduling make no API request
without `--yes`. Read commands need `emails:read`; mutation commands need
`emails:send`.

## Inspect and download received email

List inbound messages and inspect one without exposing customer content:

```bash
npm run cli -- emails receiving list --limit 20
npm run cli -- emails receiving list \
  --after recv_0123456789abcdef0123456789abcdef
npm run cli -- emails receiving get \
  recv_0123456789abcdef0123456789abcdef
```

Default list/get output contains only the opaque ID, receipt timestamp,
recipient and attachment counts, and the structured-content truncation flag.
It omits sender and recipient addresses, subject, Message-ID, bodies, headers,
attachment filenames, unrecognized server fields, and signed URLs. These
summaries still reveal operational metadata and require `emails:read`.

Stream only messages received after the command starts:

```bash
npm run cli -- emails receiving listen
npm run cli -- emails receiving listen --interval 10
npm run cli -- emails receiving listen --max-polls 3
```

`listen` seeds the newest retained ID without printing it, waits five seconds
by default, and writes one compact JSON object per new message to stdout in
oldest-first order. The output has the same metadata-only fields as `list`;
warnings use stderr so stdout remains valid NDJSON. `--interval` accepts
2–3600 seconds. `--max-polls` makes a run finite for agents and CI; omit it for
continuous monitoring.

Each polling tick evaluates at most five 100-message pages. If more mail is
waiting, the CLI retains the returned continuation cursor and up to 5,000
unseen summaries, resumes on the next tick, and prints nothing until it can
preserve chronological order. It exits instead of dropping a backlog above
that bound, and stops after five consecutive API failures. A partial page
sequence is kept and retried from the failed cursor.

Explicitly opt into the validated complete record only in a controlled
terminal:

```bash
npm run cli -- emails receiving get RECEIVED_ID \
  --include-content \
  --html-format cid
```

`--html-format` accepts `cid` or `data-uri` and requires
`--include-content`. The complete record can contain all addresses, subject,
HTML, text, headers, attachment filenames, and a short-lived raw-MIME URL.
Do not redirect it into shared CI logs or public issue reports.

Select an attachment without printing its signed URL, then download it to an
explicit local path:

```bash
npm run cli -- emails receiving attachments RECEIVED_ID
npm run cli -- emails receiving attachment \
  RECEIVED_ID ATTACHMENT_ID \
  --output ./evidence.bin
npm run cli -- emails receiving raw RECEIVED_ID \
  --output ./message.eml
```

The download commands preflight the output path before contacting HayaSend.
They refuse an existing path unless `--force` is present, fetch only from the
configured API origin, an equivalent loopback origin, or HTTPS AWS S3, never
send the API key to that URL, reject redirects, time out after 60 seconds, and
stop before writing if declared or streamed data exceeds 25 MiB. Attachment
downloads must match the API-declared byte length. Data is fully downloaded
before a private `0600` temporary file is atomically installed, so a network
or validation failure leaves no partial output. Success prints only the
canonical path, byte count, and SHA-256.

The CLI intentionally requires a user-selected `--output` rather than trusting
a message-supplied filename. `forward` is not a CLI command yet; the official
Node SDK forwarding helper remains compatible as documented in
[the migration guide](migration-from-resend.md).

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

Run the AWS workflow from a HayaSend checkout. The first invocation is a
non-mutating plan:

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
- `--enable-inbound` or `--disable-inbound`;
- `--inbound-recipient-suffixes @example.com,@example.org`;
- `--inbound-retention-days 1..30`;
- `--inbound-max-message-bytes 1..41943040`;
- `--inbound-tls-policy OPTIONAL|REQUIRED|FIPS`;
- `--webhook-retention-days 1..30`;
- `--template-history-retention-days 1..365`;
- `--template-history-limit 1..50`;
- repeatable `--tag KEY=VALUE`.

Enabling inbound receiving requires explicit non-`.invalid` recipient
suffixes. An existing bootstrap secret ARN must belong to the expected account
and Region. `Project=HayaSend` and `ManagedBy=HayaSendCLI` tags are reserved.

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
