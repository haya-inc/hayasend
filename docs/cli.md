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
npm run cli -- templates push --publish
```

`--publish` promotes every created, updated, or already-unpublished draft in
the manifest. If a create or update succeeds but its publish fails, production
continues using the previous published snapshot; rerunning the same command
resumes reconciliation. Use `--file PATH` for a differently named manifest.

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
npm run cli -- templates publish welcome
```

The deployment key needs `templates:read` and `templates:write`. Keep those
scopes out of the application runtime key.

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

The alpha CLI deliberately does not install dependencies, modify application
source, or deploy AWS resources. `deploy` and migration commands remain on the
roadmap; until then, use the reviewed SAM commands in the main README and the
operations runbook.
