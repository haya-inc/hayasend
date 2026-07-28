# hayasend.com domain operations

This runbook protects the public HayaSend domain, GitHub Pages site, and sender
authentication records. It intentionally omits registrar account identifiers,
recovery contacts, billing details, and DNS record tokens.

Production-domain hardening is tracked in
[issue #130](https://github.com/haya-inc/hayasend/issues/130). Do not describe
DNSSEC as enabled until the public registry delegation and validating-resolver
checks pass.

## Ownership controls

The domain owner must verify these controls at least quarterly and after every
ownership or billing change:

- registrar auto-renew is enabled and the payment method is current;
- transfer or registrar lock is enabled;
- at least two tested recovery contacts are recorded in the private operator
  system of record;
- every Cloudflare administrator uses phishing-resistant MFA when available,
  with recovery material stored outside the Cloudflare account;
- the registrant email remains verified and monitored;
- renewal and security notifications reach more than one authorized operator.

Do not publish screenshots or issue comments that reveal account identifiers,
recovery codes, contact data, payment details, or DNS-change authorization
material.

## Protected records

Treat the following record groups as one reviewed change surface:

- apex GitHub Pages A and AAAA records;
- the `www` GitHub Pages CNAME;
- the GitHub Pages custom-domain and HTTPS settings;
- SES Easy DKIM CNAME records;
- the SES custom MAIL FROM MX and SPF records;
- the apex DMARC policy;
- any Cloudflare Email Sending verification records.

Export or otherwise record the current configuration in the private operator
system before changing any of these groups. Never delete a record only because
it is unfamiliar; first map it to GitHub Pages, Amazon SES, Cloudflare, or a
documented owner.

## DNSSEC activation

Cloudflare Registrar supports one-click DNSSEC. Use the dashboard account that
owns the exact `hayasend.com` registration:

1. Confirm the domain is active, auto-renew is on, transfer lock is on, and
   administrative MFA is enabled.
2. Confirm apex, `www`, DKIM, custom MAIL FROM, SPF, and DMARC records resolve
   correctly before signing the zone.
3. In **Manage Domains**, open `hayasend.com`, then choose
   **Configuration → Enable DNSSEC**.
4. Record only the activation time and status in the operator log. Do not copy
   recovery or account data into a public issue.
5. Wait for Cloudflare Registrar to publish the registry DS record. Cloudflare
   documents that the registrar synchronization can take one to two days.
6. Keep issue #130 open until both the public chain and application checks
   below pass.

If the domain is ever moved to a different DNS provider, disable DNSSEC and
confirm removal of the parent DS before changing nameservers. A stale DS with
an unsigned or differently signed zone can make the entire domain
unresolvable.

Official references:

- [Cloudflare Registrar: enable DNSSEC](https://developers.cloudflare.com/registrar/get-started/enable-dnssec/)
- [Cloudflare DNSSEC](https://developers.cloudflare.com/dns/dnssec/)
- [Cloudflare Registrar renewals](https://developers.cloudflare.com/registrar/account-options/renew-domains/)

## Public verification

Run these checks from a clean network after the registry DS appears:

```bash
dig +dnssec DS hayasend.com
dig +dnssec DNSKEY hayasend.com
dig +dnssec A hayasend.com
```

The DS and DNSKEY must be present, signatures must validate, and a validating
resolver must return authenticated data. Also verify:

```bash
curl --fail --silent --show-error --head https://hayasend.com/
curl --fail --silent --show-error --head https://www.hayasend.com/
```

The apex must return the GitHub Pages site over HTTPS and `www` must redirect
to the canonical apex. Then verify the SES identity in the designated test
account and Region:

```bash
aws sesv2 get-email-identity \
  --region ap-northeast-1 \
  --email-identity hayasend.com
```

Require successful identity verification, Easy DKIM, and custom MAIL FROM.
Never paste the complete command output into a public issue; record only status,
Region, timestamp, and redacted evidence.

## Change and rollback discipline

- Use two-person review for nameserver, DNSSEC, apex, DKIM, MAIL FROM, SPF, or
  DMARC changes once supported production service begins.
- Change one record group at a time and wait at least its previous TTL before
  declaring the change stable.
- Verify both the website and sender-authentication paths after every change.
- If validation fails, stop further changes and restore the exact previous
  record set. Do not change nameservers while a parent DS remains active.
- Record the incident, affected TTLs, rollback time, and final public checks
  without exposing secrets or personal data.
