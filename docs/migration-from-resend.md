# Migrating from Resend

HayaSend is not yet production-ready, but the intended migration path is:

1. Deploy HayaSend into a non-production AWS account.
2. Verify a dedicated test subdomain.
3. Keep the official Resend SDK and change only its `baseUrl` and API key.
4. Replay contract and integration tests.
5. Register webhooks and verify signatures against raw request bodies.
6. Compare delivery, bounce, complaint, and delay events.
7. Move a small transactional stream before broad rollout.

```ts
const email = new Resend(process.env.HAYASEND_API_KEY, {
  baseUrl: process.env.HAYASEND_BASE_URL,
});
```

Do not switch production traffic until suppression lists, AWS SES production
access, alarms, dead-letter queue handling, and rollback have been verified.

## Inventory the real workload

Create a versioned inventory before changing application traffic. Do not infer
compatibility from a single successful send. Record every SDK, send field,
template, webhook, suppression, schedule, inbound path, marketing API, and
independently routable stream:

```json
{
  "schema_version": 2,
  "workload": {
    "name": "account notifications",
    "environment": "production",
    "estimated_daily_volume": 1000
  },
  "sdks": [
    {
      "language": "TypeScript",
      "package": "resend",
      "version": "6.18.1"
    }
  ],
  "transport": {
    "mode": "official_sdk",
    "endpoint_switch": "configuration",
    "rollback": "configuration"
  },
  "inspection": {
    "source_reviewed": true,
    "provider_account_reviewed": true,
    "observed_at": "2026-07-29T00:00:00.000Z"
  },
  "features": {
    "send_fields": [
      "from",
      "to",
      "subject",
      "html",
      "text",
      "headers",
      "tags",
      "idempotency_key"
    ],
    "templates": { "used": true, "count": 4 },
    "webhooks": {
      "events": [
        "email.sent",
        "email.delivered",
        "email.bounced",
        "email.complained"
      ],
      "verifies_signatures": true
    },
    "suppressions": { "used": true, "estimated_count": 25 },
    "schedules": { "used": false, "maximum_horizon_days": 0 },
    "inbound": { "used": false },
    "marketing": { "used": false, "apis": [] }
  },
  "streams": [
    {
      "name": "password-reset",
      "criticality": "critical",
      "daily_volume": 100,
      "required_canary_messages": 25,
      "features": [
        "from",
        "to",
        "subject",
        "html",
        "text",
        "headers",
        "tags",
        "idempotency_key",
        "templates",
        "webhooks",
        "suppressions"
      ]
    }
  ]
}
```

Validate the file without contacting either provider:

```bash
hayasend migration resend inventory \
  --file ./hayasend.resend-inventory.json
```

Schema v2 records whether the workload uses the official SDK, a direct HTTP
integration, or SMTP; whether switching requires configuration, application
code, or provider-managed settings; and how Resend rollback will be performed.
It also attests that both application source and the Resend account were
reviewed. Schema v1 remains parseable so existing inventory files get an
actionable result, but it is `BLOCKED` until upgraded to v2.

The result is also `BLOCKED` for SMTP, an unreviewed source or provider
account, unknown send fields or webhook events, schedules beyond 30 days,
missing raw-body webhook signature verification, or any Resend
marketing/contact/audience/broadcast API. HayaSend does not expose an SMTP
relay. An SMTP workload must move to the supported HTTP API or keep its SMTP
provider. A supported inventory is only `CANARY_ELIGIBLE`; it is not a
production-readiness claim.

### Supabase Auth: replace SMTP with the HTTPS Send Email Hook

Do not add an SMTP relay only to migrate Supabase Auth. Current Supabase Auth
can replace its built-in SMTP submission with a signed HTTPS Send Email Hook.
The deployable
[`examples/supabase-auth-send-email-hook`](../examples/supabase-auth-send-email-hook/)
bridge verifies the Standard Webhooks signature over the exact raw body, maps
the hook ID to a HayaSend idempotency key, renders every currently documented
Auth email action, and submits through an `emails:send` scoped HayaSend key.

The bridge uses a 3.5-second HayaSend timeout inside Supabase's documented
five-second total HTTP-hook budget. It returns `503` with `Retry-After: 2`
only for throttling, timeout, or temporary unavailability so Supabase's
documented retry behavior remains bounded. Permanent request rejection does
not create a retry storm. Keep the existing Resend SMTP configuration as the
tested rollback until terminal delivery, mailbox receipt, and the
workload-specific GO report pass.

## Run a controlled dual-provider canary

Use one synthetic message and a mailbox controlled by the migration operator.
The plan sends nothing and prints the SHA-256 confirmation required for apply:

```bash
hayasend migration resend canary \
  --comparison-id password-reset-001 \
  --from 'Canary <canary@verified.example.com>' \
  --to-file /secure/path/controlled-recipient.txt \
  --hayasend-endpoint https://api.hayasend.example.com
```

Set `HAYASEND_API_KEY` and `RESEND_API_KEY` in the environment, then repeat the
exact command with `--apply` and the printed
`--confirm-hayasend-origin ORIGIN` and `--confirm-recipient-sha256 VALUE`
values. The HayaSend key needs `emails:send` and `emails:read`. The command
submits the same synthetic payload once to each provider, with
provider-specific idempotency keys, and polls `GET /emails/:id` for terminal
lifecycle events. The Resend credential is sent only to the fixed official
`https://api.resend.com` origin. Resend documents a 24-hour idempotency window,
so keep the comparison ID unique and preserve the result.

Only email IDs, terminal states, and the recipient hash are printed. The
address, message body, and API keys are not logged. The command deliberately
leaves `mailbox_receipt_verified: false`: a human or independently trusted
mailbox automation must confirm both rendered messages and record latency.
Keep application routing on Resend, rehearse restoring 100% Resend routing,
and only then count `rollback_rehearsed`.

## Produce the fail-closed go/no-go report

Record evidence separately from the inventory:

```json
{
  "schema_version": 1,
  "observed_at": "2026-07-29T00:00:00.000Z",
  "ses": {
    "production_access": false,
    "sending_enabled": true
  },
  "dogfood": {
    "calendar_days": 0,
    "controlled_notifications": 0
  },
  "references": {
    "ses": "https://github.com/haya-inc/hayasend/issues/126",
    "dogfood": "https://github.com/haya-inc/hayasend/issues/105",
    "reconciliation": "https://github.com/haya-inc/hayasend/issues/174"
  },
  "reconciliation": {
    "sdk_contract_verified": false,
    "source_templates": 4,
    "target_templates": 4,
    "source_suppressions": 25,
    "target_suppressions": 25,
    "webhooks_verified": true,
    "inbound_verified": false
  },
  "streams": [
    {
      "name": "password-reset",
      "comparison_messages": 0,
      "terminal_event_matches": 0,
      "mailbox_receipts": 0,
      "rollback_rehearsed": false,
      "verified_features": [],
      "evidence_url": "https://github.com/haya-inc/hayasend/issues/174"
    }
  ]
}
```

```bash
hayasend migration resend report \
  --inventory ./hayasend.resend-inventory.json \
  --evidence ./hayasend.resend-evidence.json
```

The result remains `NO_GO` unless:

- the inventory has no compatibility blocker;
- the operational snapshot is no more than 24 hours old and every claim links
  to its reviewable evidence;
- the exact inventoried SDK versions and every declared stream feature pass
  their contract and controlled-canary checks;
- SES production access and sending are enabled;
- at least 1,000 controlled notifications have run over at least 14 calendar
  days;
- template and suppression counts reconcile exactly;
- webhook and any inbound paths are verified;
- every stream meets its declared comparison count with matching terminal
  events, at least one mailbox receipt, and a rehearsed Resend rollback.

Until all gates pass, critical authentication, billing, and account-recovery
mail stays on Resend.

Register each webhook with the CLI so its one-time signing secret is written to
a new permission-`0600` file instead of terminal output:

```bash
mkdir -m 700 .secrets
npm run cli -- webhooks create \
  --url https://hooks.example.com/hayasend \
  --event email.sent \
  --event email.delivered \
  --event email.bounced \
  --secret-file .secrets/hayasend-webhook
```

Move that file into the receiver's secret manager, verify requests against the
raw body and `svix-*` headers, then delete the local copy through the
organization's approved secret-handling process. The
[CLI guide](cli.md#manage-and-recover-webhooks) covers delivery inspection and
explicit replay.

Recreate known blocked recipients in HayaSend before the first canary. For a
small evaluation set, use the CLI so the address does not need to appear in the
process list:

```bash
npm run cli -- suppressions add \
  --email-file /secure/path/recipient.txt \
  --detail-file /secure/path/migration-reference.txt
```

The command creates only a manual HayaSend suppression. It does not change the
Amazon SES account-level suppression list, and it intentionally does not offer
an unaudited bulk importer. Use a reviewed API migration program for a larger
source list, reconcile counts before sending, and retain no exports longer than
necessary. See
[the CLI guide](cli.md#manage-suppressions-safely).

The command shape for a non-interactive canary remains close to Resend:

```bash
hayasend emails send \
  --from 'Canary <sender@test.example.com>' \
  --to controlled-recipient@example.net \
  --subject 'Migration canary' \
  --html-file ./canary.html \
  --text-file ./canary.txt \
  --idempotency-key migration-canary-001
```

HayaSend additionally uploads local `--attachment` files through its
checksum-bound direct-upload extension before creating the email. Use only
synthetic content and controlled recipients during migration. The command
requires `emails:send` and prints only the resulting email ID.

During the canary phase, inspect HayaSend without copying customer content into
logs:

```bash
hayasend emails list --limit 20
hayasend emails get email_0123456789abcdef0123456789abcdef
```

The default output is metadata-only. If rollback requires stopping a queued
canary, use `hayasend emails cancel ID --yes`. Reschedule only after confirming
the intended UTC time with
`hayasend emails update ID --scheduled-at TIME --yes`. The migration operator
needs `emails:read` for inspection and `emails:send` for these changes.
`--include-content` is an exceptional debugging option and can reveal the
complete message.

The official SDK's inline base64 attachments continue to work. Files that
would approach API Gateway's request limit should use HayaSend's
`POST /attachments` HTTP extension and then be sent as
`attachments: [{ attachment_id: "att_..." }]`.

The official Node SDK's receiving forward helper also works unchanged:

```ts
await email.emails.receiving.forward(
  {
    emailId: receivedEmailId,
    from: "Forwarder <forwarder@verified.example.com>",
    to: "archive@example.net",
  },
  { idempotencyKey: `forward-${receivedEmailId}` },
);
```

Use a key with both `emails:read` and `emails:send`. The helper downloads the
short-lived raw MIME URL, parses it locally, and submits the body and
attachments through `POST /emails`. The `from` value must use a sending
identity verified in the deployment's SES account; never substitute the
untrusted original sender address.

Hosted templates can be migrated without changing application send calls.
Create and publish each template through the official SDK, then continue using
`template: { id, variables }`. HayaSend accepts both template IDs and aliases.
Give the migration job `templates:read` and `templates:write`; the application
sender itself needs only `emails:send`. See
[hosted templates](hosted-templates.md) for the draft/publication boundary and
version-retention controls.

Publication history begins with versions published by HayaSend after this
feature is deployed; existing Resend history and legacy HayaSend snapshots are
not backfilled. A restore is intentionally not an instant production rollback:
it creates a new unpublished draft, which should be rendered and reviewed
before an explicit conditional publish. The previously published snapshot
continues serving sends during that review.

## Preserve email threads

After SES accepts an outbound message, HayaSend includes its provider-assigned
`message_id` in sent-email retrieve/list responses and outbound email
webhooks. Capture it from `email.sent` when immediate correlation matters,
because the initial send response is returned while the message is still
queued.

Use that exact value in standard threading headers on a later send:

```ts
await resend.emails.send({
  from: "Support <support@verified.example.com>",
  to: "customer@example.net",
  subject: "Re: Your request",
  text: "Here is the update.",
  headers: {
    "In-Reply-To": originalMessageId,
    References: originalMessageId,
  },
});
```

HayaSend does not invent a Message-ID for scheduled, suppressed, or failed
messages that SES has not accepted. The `Message-ID` send header is reserved
because SES assigns and overrides it; use `In-Reply-To` and `References` for
threading instead.
