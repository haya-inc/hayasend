# Supabase Auth Send Email Hook

This example moves Supabase Auth email from SMTP to HayaSend's HTTPS API. It
does not add an SMTP relay or custom MTA. Supabase signs the raw hook body with
Standard Webhooks; the function verifies that signature before submitting an
email.

The example pins the current `standardwebhooks@1.0.0` package and is checked
with Deno 2.9.4. Supabase CLI commands below pin the current `supabase@2.110.0`
release.

Contributors need Deno 2.9.4 on `PATH` to run `npm run check:supabase-hook`. CI
and Release install it with the pinned official setup action. Deno is
intentionally not an npm dependency, so the product's Alpine/musl container
install remains portable and does not include the example-only toolchain.

HayaSend remains early beta. Keep authentication, recovery, and
security-notification traffic on the existing provider until AWS SES production
access, terminal delivery, a controlled hook canary, mailbox receipt, and
rollback rehearsal have passed.

## Security and delivery behavior

- The function reads at most 64 KiB and verifies the exact raw request body.
- The `webhook-id` is SHA-256 hashed into a bounded HayaSend idempotency key.
- Startup fails closed unless `HAYASEND_API_KEY` is an exact scoped HayaSend
  key; bootstrap and local development keys are rejected.
- The HayaSend request times out after 3.5 seconds, inside Supabase's
  five-second total HTTP-hook budget.
- Redirects are rejected so the scoped bearer credential never follows a
  HayaSend endpoint redirect.
- HayaSend throttling and temporary unavailability return `503` with
  `Retry-After: 2`, which matches Supabase's documented retry behavior.
- Permanent HayaSend request rejection returns `422` and does not create a retry
  storm.
- Logs contain only a bounded error category. They exclude hook bodies,
  addresses, tokens, message content, credentials, and raw provider errors.
- All currently documented Supabase Auth email action types are rendered.
- Secure Email Change follows Supabase's dual-message contract: the current and
  new addresses receive their documented token-hash pair with distinct,
  deterministic HayaSend idempotency claims.

## 1. Issue a least-privilege HayaSend key

Use the bootstrap administrator key only to create the scoped key. The CLI
writes the one-time token to a new mode-`0600` file and never prints it:

```bash
mkdir -m 700 .secrets

HAYASEND_API_KEY="$HAYASEND_BOOTSTRAP_KEY" \
  npx --yes @haya-inc/hayasend@0.3.8 keys create \
    --name "supabase-auth-send-email-hook" \
    --scope emails:send \
    --expires-at 2026-10-30T00:00:00Z \
    --token-out .secrets/supabase-auth-hayasend.token
```

Move the token into the Supabase project secret store, then remove the local
copy through the organization's approved secret-handling process.

## 2. Install the function

Copy this directory into the Supabase project's function tree:

```text
supabase/
  functions/
    hayasend-auth-email/
      deno.json
      email.ts
      handler.ts
      index.ts
```

Create a local `.env.supabase-auth-hook` from `.env.example`. Do not commit it.
Set `SEND_EMAIL_HOOK_SECRET` to the secret generated when the HTTPS Send Email
Hook is created in the Supabase dashboard. The function accepts Supabase's
displayed `v1,whsec_...` form and normalizes it before verification.

Load the secret values without placing them in shell history:

```bash
npx --yes supabase@2.110.0 secrets set \
  --env-file .env.supabase-auth-hook
```

Deploy without Supabase JWT verification because Standard Webhooks is the
authentication boundary:

```bash
npx --yes supabase@2.110.0 functions deploy hayasend-auth-email \
  --no-verify-jwt
```

## 3. Configure the hook

In the Supabase dashboard:

1. Open **Authentication → Hooks**.
2. Create a **Send Email** hook with type **HTTPS**.
3. Use the deployed `hayasend-auth-email` function URL.
4. Generate the hook secret and make sure the same value is stored as
   `SEND_EMAIL_HOOK_SECRET`.

Enabling the hook replaces Supabase's built-in SMTP submission. Do not enable it
for production before the controlled canary below.

## 4. Controlled canary and rollback

Use a non-production Supabase project and a controlled mailbox. Exercise at
least signup, invite, magic link, recovery, email change, reauthentication, and
every enabled security notification. Verify:

- one HayaSend email record per logical message for repeated delivery of the
  same hook ID;
- both current/new messages and token hashes when Secure Email Change is
  enabled;
- terminal delivery and controlled mailbox receipt;
- correct links, codes, expiry, redirects, and rendering;
- no recipient, token, subject/body, or raw provider error in function logs;
- a temporary HayaSend failure results in bounded Supabase retries.

Rollback is configuration-only: disable the Send Email Hook and verify that the
pre-existing SMTP configuration still sends to the controlled mailbox. Keep that
SMTP configuration and its credential available until the workload-specific
HayaSend GO report passes.
