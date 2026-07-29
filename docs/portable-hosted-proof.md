# Portable hosted semantic proof

Database and private-object restoration use the separate
[portable backup and restore proof](portable-backup-restore-proof.md).

HayaSend includes one provider-neutral proof for the `portable-postgres`
runtime. It exercises a deployed API, its exact isolated PostgreSQL database,
and the already-running worker or reconciliation trigger without submitting
mail to an external provider.

This proof is for the first, non-sending deployment phase. It is not terminal
delivery evidence and must never be run against a production or shared
database.

## What it proves

The runner:

1. refuses any transport other than `console`;
2. requires the exact `isolated-non-sending` confirmation used by the runtime;
3. checks the deployed `/healthz` and `/readyz` version identity;
4. verifies PostgreSQL connectivity and refuses any non-empty application
   database;
5. creates one scheduled email more than seven days in the future and replays
   the same idempotency key;
6. verifies the atomic email, message, recipient, idempotency, outbox, and
   delayed-job rows;
7. atomically removes only that fixture's wake-up job and advances only that
   fixture's authoritative PostgreSQL due rows;
8. waits for the deployed worker or reconciliation trigger to recover the
   lost wake-up;
9. verifies console-provider acceptance across the message, recipient,
   attempt, and outbox ledgers; and
10. deletes the fixture and verifies that all of its delivery and job rows are
    gone.

The controlled due-row advance proves the long-delay storage and recovery
semantics without claiming that a real 8–30 day observation elapsed.

It does not prove:

- delivery to a recipient mailbox;
- provider webhook signatures or terminal delivery, bounce, complaint, and
  suppression states;
- backup and restore, high availability, autoscaling, upgrade, or rollback;
- external attachment storage;
- provider resource deletion or zero billing residue; or
- the safety of any environment other than the exact isolated proof
  deployment.

Those remain separate gates in each provider issue.

## Safety prerequisites

Use a new, empty, dedicated PostgreSQL database and a deployment configured
with:

```text
HAYASEND_MODE=portable
HAYASEND_TRANSPORT=console
HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending
```

The API, worker, and runner must use the same dedicated database and API key.
The database URL supplied to the runner is authoritative: the runner verifies
connectivity and PostgreSQL version, then refuses to proceed if any HayaSend
application or job row already exists. Use provider resource metadata and
private connection settings to verify the target before running it.

Run it from a provider-private shell, one-shot job, or an operator host with
approved encrypted access to both the API origin and database. Do not expose a
private database publicly merely to run this proof.

## Run

Build the reviewed checkout that exactly matches the deployed image:

```bash
npm ci
npm run build
```

Set secrets only in the current process environment:

```bash
export HAYASEND_HOSTED_PROOF_API_URL="https://api.example.invalid"
export HAYASEND_DATABASE_URL="postgresql://..."
export HAYASEND_API_KEY="re_..."
export HAYASEND_TRANSPORT="console"
export HAYASEND_CONSOLE_PROOF_CONFIRM="isolated-non-sending"
npm run proof:portable-hosted > portable-proof.json
```

The default fixture is scheduled 30 days ahead and the recovery timeout is
120 seconds. A provider with a slower documented reconciliation interval may
use:

```bash
export HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS="8"
export HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS="300"
```

The allowed schedule range is 8–30 days and the timeout range is 10–900
seconds.

By default, the runner deletes its fixture on both success and recoverable
failure. Retaining a successful fixture requires both:

```bash
export HAYASEND_HOSTED_PROOF_RETAIN="true"
export HAYASEND_HOSTED_PROOF_RETAIN_CONFIRM="retain-isolated-proof-fixture"
```

Retention is intended only for an active private investigation. Remove the
fixture before closing the provider proof.

## Evidence handling

Successful JSON evidence includes a random run ID, hashes the API origin, and
reports only version, database-engine, state-transition, and cleanup facts. It
does not include credentials, addresses, content, database URLs, or raw
errors.

Store the full JSON in the private release evidence archive. Public issue
comments may include it because it is content-free, but still review it before
posting. A failure emits only a stable error category; investigate detailed
runtime logs in the access-controlled provider console.
