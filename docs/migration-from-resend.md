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
