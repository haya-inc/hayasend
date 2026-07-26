# Open-source and commercial boundary

## Open-source core

The self-hosted transactional path remains Apache-2.0:

- API and SDK compatibility;
- AWS deployment templates;
- SES transport and event normalization;
- queues, retries, idempotency, and webhooks;
- hosted templates, React Email interoperability, template-as-code
  reconciliation, and safe version publishing;
- inbound and forwarding primitives when implemented;
- security fixes and documented upgrade paths.

The project must remain genuinely useful without a Haya commercial service.

## Services Haya can sell

Haya's defensible value is operational accountability rather than artificial
source restrictions:

- architecture and migration projects;
- production deployment and security hardening;
- deliverability and sender-reputation operations;
- monitoring, incident response, backups, and upgrades;
- multi-account fleet management;
- compliance evidence and support commitments;
- a future hosted control plane that never needs to inspect message content.

## Product principles

1. Do not put a critical security fix behind a paid plan.
2. Do not create an unusable “community edition”.
3. Keep customer email data in the customer's AWS account by default.
4. Publish compatibility and support limits precisely.
5. Price accountability, convenience, and operational expertise.

Apache-2.0 maximizes adoption and includes an explicit patent grant. Trademark
policy prevents confusing third-party services from presenting themselves as
official HayaSend.
