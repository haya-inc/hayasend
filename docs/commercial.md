# Open-source and commercial boundary

## Open-source core

The self-hosted transactional path remains Apache-2.0:

- API and SDK compatibility;
- customer-owned AWS and Cloudflare deployment targets;
- open provider capability contracts, adapters, and conformance tests;
- provider transport and recipient-event normalization;
- queues, retries, idempotency, and webhooks;
- hosted templates, React Email interoperability, template-as-code
  reconciliation, safe version publishing, and bounded restore-to-draft
  history;
- inbound and forwarding primitives when implemented;
- security fixes and documented upgrade paths.

The project must remain genuinely useful without a Haya commercial service.
The [reproducible AWS cost model](aws-costs.md) exposes the self-hosting
assumptions and service charges instead of using opaque “contact sales”
pricing.

## Services Haya can sell

Haya's defensible value is operational accountability rather than artificial
source restrictions:

- architecture and migration projects;
- production deployment and security hardening;
- deliverability and sender-reputation operations;
- monitoring, incident response, backups, and upgrades;
- template migration, review workflows, and retention-policy design;
- multi-account fleet management;
- provider migration, conformance certification, and failure drills;
- compliance evidence and support commitments;
- a future hosted control plane that never needs to inspect message content.

## Management-plane data boundary

An optional Haya service may receive deployment identity, software and adapter
version, capability digest, health, counts, durations, aggregate cost, and
opaque incident references. By default it must not receive sender or recipient
addresses, subjects, bodies, attachments, provider credentials, raw provider
events, or signed URLs.

Deploy, doctor, upgrade, rollback, recovery, provider adapters, conformance,
and security fixes remain part of the open data plane. Paid value comes from
operating fleets and accepting support accountability, not from withholding a
safe standalone product.

## Product principles

1. Do not put a critical security fix behind a paid plan.
2. Do not create an unusable “community edition”.
3. Keep customer email data in the customer's cloud account by default.
4. Publish compatibility and support limits precisely.
5. Price accountability, convenience, and operational expertise.

Apache-2.0 maximizes adoption and includes an explicit patent grant. Trademark
policy prevents confusing third-party services from presenting themselves as
official HayaSend.
