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
