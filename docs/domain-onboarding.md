# Sending-domain onboarding

HayaSend registers an Amazon SES sending identity and returns the DNS records
an operator must review and apply. It never edits Route 53 or another DNS
provider.

Use an API key with `domains:write` for create, verify, and delete, plus
`domains:read` for list and get. Keep the key in the environment:

```bash
export HAYASEND_BASE_URL=https://your-api-id.execute-api.ap-northeast-1.amazonaws.com
export HAYASEND_API_KEY=your-secret-from-an-approved-secret-manager
```

Register an isolated sending subdomain rather than the organizational apex:

```bash
npm run --silent cli -- domains create --name mail.example.com
```

The JSON response includes the domain ID, current status, deployment Region,
and DNS records. Copy the returned DKIM `CNAME` records exactly into the
authoritative DNS zone. The returned DMARC `TXT` record is a conservative
starting policy and is not what SES uses to complete DKIM verification;
review it with the domain owner before applying it.

DNS propagation is asynchronous. Refresh HayaSend's stored SES state after
the records have propagated:

```bash
npm run --silent cli -- domains verify \
  dom_0123456789abcdef0123456789abcdef
npm run --silent cli -- domains get \
  dom_0123456789abcdef0123456789abcdef
```

`verify` performs one provider-state refresh. It does not change DNS, send
mail, or wait indefinitely. Continue only when the returned domain status is
`verified` and the DKIM records are `verified`.

List registered identities with an optional cursor:

```bash
npm run --silent cli -- domains list --limit 20
npm run --silent cli -- domains list --limit 20 \
  --after dom_0123456789abcdef0123456789abcdef
```

Run a controlled canary before moving application traffic. Use the same
subdomain in the `From` address and confirm delivery events, suppressions, and
alarms as described in the [operations runbook](operations.md).

Deleting a domain removes both its SES identity and its HayaSend record. The
CLI refuses the request unless the destructive action is acknowledged:

```bash
npm run --silent cli -- domains delete \
  dom_0123456789abcdef0123456789abcdef --yes
```

This does not remove DNS records. Coordinate DNS cleanup separately, and keep
records in place if another authorized mail system still relies on them.
