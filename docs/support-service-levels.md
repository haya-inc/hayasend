# Commercial support and service levels

HayaSend is Apache-2.0 software and remains fully usable without a commercial
agreement. Haya, Inc. sells operational accountability and professional
services separately from access to the source code.

## Current availability

HayaSend is currently early beta. Commercial discovery, architecture reviews,
migrations, and non-critical evaluation support are available now.
Production support and contractual incident-response service levels do not
start until the production-qualification evidence tracked in
[GitHub milestone 2](https://github.com/haya-inc/hayasend/milestone/2) is
complete and the agreement names a supported HayaSend release and provider.

Cloudflare Email Sending remains Beta and is not a production-supported
transport.

## Contact

Use the private
[Haya contact form](https://www.haya.company/contact) or email
`info@haya.company` for commercial inquiries. The public contact policy targets
a reply within two Japanese business days.

The initial message should contain only:

- organization and contact details;
- intended provider and AWS Region or Cloudflare deployment model;
- approximate monthly volume and desired timeline;
- requested service, such as migration, architecture review, or support;
- compliance or data-residency requirements at a high level.

Do not send credentials, API keys, AWS account identifiers, recipient
addresses, message bodies, raw provider events, signed URLs, or private logs in
the initial inquiry. Haya will establish an agreed secure exchange before
requesting sensitive diagnostic material.

The contact form is covered by
[Haya's privacy policy](https://www.haya.company/legal). A services agreement,
data-processing agreement, or regulated-environment addendum is scoped when
the engagement requires it.

## Initial service catalog

- fixed-scope architecture and deployment review;
- migration from Resend, direct Amazon SES, or legacy SES forwarders;
- DNS, SPF, DKIM, DMARC, bounce, and complaint readiness review;
- security hardening and AWS or Cloudflare account review;
- upgrade, rollback, recovery, and provider-switch drills;
- deliverability investigation and sender-reputation operations;
- multi-account fleet, compliance-evidence, and private-roadmap work;
- supported production operations after the qualification gate.

## Baseline response targets

These targets apply only when an executed order or support agreement references
this document. They are measured during Japanese business days,
09:00–18:00 JST, excluding public holidays. Twenty-four-hour coverage and
different targets require an explicit agreement.

| Severity | Example | Initial response target |
| --- | --- | --- |
| Severity 1 | Supported production send path is unavailable, or there is a credible security or data-loss risk | 4 business hours |
| Severity 2 | Material degradation with a viable workaround, or a repeated delivery-semantics failure | 1 business day |
| Severity 3 | Deployment guidance, planned change, compatibility question, or non-urgent defect | 2 business days |

An initial response acknowledges the incident, confirms severity and ownership,
and identifies the next evidence or mitigation step. It is not a resolution-time
or inbox-placement guarantee.

Community Issues and Discussions remain best-effort and have no response-time
commitment.

## Customer responsibilities

The customer retains ownership of its cloud account and must:

- maintain valid provider and cloud-service agreements;
- control production credentials, access, backups, and recovery contacts;
- keep sender identities, quotas, bounce and complaint processing healthy;
- run a supported HayaSend release and provide metadata-only diagnostics;
- notify Haya before material provider, Region, DNS, or topology changes;
- avoid sending unlawful, unsolicited, or policy-violating email.

## Exclusions

Haya cannot guarantee recipient inbox placement or control Amazon SES or
Cloudflare availability, quotas, account suspension, suppressions, recipient
mailbox filtering, or third-party DNS and network behavior. Those systems can
be investigated and operated within an engagement, but their outcomes are not
HayaSend service-level guarantees.

Source access, documented standalone deployment, and critical security fixes
are never conditioned on a commercial plan.
