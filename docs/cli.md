# CLI guide

The HayaSend CLI provides non-interactive building blocks for local setup,
connectivity checks, and end-to-end send verification. During the alpha it runs
from a source checkout:

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

## Scope

The alpha CLI deliberately does not install dependencies, modify application
source, or deploy AWS resources. `deploy` and migration commands remain on the
roadmap; until then, use the reviewed SAM commands in the main README and the
operations runbook.
