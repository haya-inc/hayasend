# AWS SES dogfood campaign

The `AWS SES dogfood` workflow collects the long-running delivery evidence
required by [issue #105](https://github.com/haya-inc/hayasend/issues/105).
It exercises the protected `hayasend` stack in the dedicated general-purpose
test account. It does not move customer traffic and is not, by itself, a
production migration approval.

## Workload

One 14-day campaign contains four UTC slots per day and 18 notifications per
slot: 72 per day and 1,008 in total. The synthetic notifications model four
FolioMCP-shaped paths:

- PDF completed;
- PDF failed;
- sharing created;
- quota warning requiring operator attention.

Every message states that it contains no customer or private content. The
workflow uses one verified HayaSend sender and one controlled mailbox. A
deterministic idempotency key identifies each date, slot, and sequence, so a
re-run inspects the same HayaSend records instead of creating another batch.

## Fixed safety boundary

The workflow fails closed unless all of these facts remain true:

- GitHub is running the exact default `main` branch;
- the `aws-integration` environment enables the campaign;
- AWS account `330599756148` and Region `ap-northeast-1` are selected;
- the stack is exactly `hayasend`, stable, protected, and `IN_SYNC`;
- the stack remains tagged as managed by HayaSend CLI;
- SES production sending and the `hayasend.com` identity remain enabled;
- HayaSend reports `operational` and `send_ready`, with every discovered alarm
  in `OK`, before and after the slot.

The workflow only reads stack state and sends controlled messages. It never
updates or deletes the stack and never disables termination protection. AWS
credentials come from GitHub OIDC. Each slot creates a scoped
`emails:send`/`emails:read` API key and revokes it even when the slot fails.

## Enable one campaign

Set these environment variables on `aws-integration` only after the
implementation has merged and exact-main CI and CodeQL are green:

```text
AWS_DOGFOOD_ENABLED=true
AWS_DOGFOOD_START_DATE=YYYY-MM-DD
```

The start date is UTC and is immutable during a campaign. The workflow uses
the existing `AWS_TEST_*` and `AWS_TERMINAL_*` environment variables for the
approved account, Region, OIDC role, identity, controlled sender, and
controlled recipient.

Run the first slot manually with the exact account confirmation. Scheduled
runs occur at minute 17 of hours 00, 06, 12, and 18 UTC. If GitHub delays or
misses a slot, dispatch that date and slot manually before its 24-hour
HayaSend idempotency window closes. The workflow refuses older backfills,
because reusing a key after its retention expires could create another email.
An unrecovered slot invalidates the 14-day campaign and requires a new fixed
window. Do not change the start date of a campaign already in progress.

Set `AWS_DOGFOOD_ENABLED=false` for the kill switch. Runs outside the fixed
14-day window create no sends even if the switch was not cleared immediately.

## Evidence

Each successful slot uploads one 90-day artifact containing:

- the fixed campaign plan;
- delivery, terminal recipient, and immutable ledger counts;
- SHA-256 hashes of HayaSend and provider identifiers, never raw recipients or
  message bodies;
- queue-to-provider, provider-terminal, provider-event-ingest, and end-to-end
  latency summaries;
- retry and duplicate counts;
- pre/post operational, drift, SES, health, and alarm snapshots;
- total operator runtime and confirmation that the scoped API key was revoked;
- one synthetic subject that can be matched to a controlled mailbox receipt.

The raw API response needed for in-run DynamoDB correlation remains in the
ephemeral GitHub runner and is not uploaded. Add the first successful run to
#105. During the window, perform one normal reviewed upgrade and recovery.
After downloading and extracting all successful artifacts, reconcile them:

```bash
find /secure/path/to/extracted-artifacts \
  -name aws-dogfood-evidence.json \
  -print0 \
  | xargs -0 jq --slurp --compact-output \
  | node scripts/aws-dogfood-report.mjs
```

The report refuses mixed windows, missing slots, divergent re-runs, incomplete
ledgers, non-OK alarm snapshots, or anything other than 1,008 unique terminal
deliveries. Sample the controlled mailbox, record any incidents and regression
tests, and add the final go/no-go report to #105 and #174 before considering
any Resend customer stream for migration.
