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
