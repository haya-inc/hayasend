# Roadmap

The roadmap is ordered by user risk, not by feature count.
The evidence gates, adapter contract, and current draft disposition are in the
[production semantics and Cloudflare proof](docs/execution-plan.md) plan.

## Release gate — AWS beta

- [x] Resend-compatible single and batch send endpoints
- [x] official Resend Node SDK contract test
- [x] idempotency, cancellation, and scheduling
- [x] SES transport and domain verification
- [x] delivery events and signed webhook retries
- [x] serverless AWS SAM deployment
- [x] API-key records with scopes, expiry, and revocation
- [x] suppression-list enforcement before enqueue
- [x] EventBridge Scheduler for long schedules
- [x] presigned S3 attachment uploads beyond the API Gateway payload limit
- [x] first successful deployment integration run in a dedicated AWS test
      account (OIDC deploy/test/delete workflow is ready)
- [x] bootstrap-key storage in Secrets Manager
- [x] protected-main merge, exact-main CodeQL, signed release, provenance, and
      live project site

No post-v0.1 draft merges into the frozen release candidate.

## Now — Production semantics

- versioned provider capability and compatibility contract
- transactional outbox with automatic reconciliation
- immutable recipient, attempt, and provider-event ledger
- deterministic aggregates under duplicate and out-of-order events
- permanent/retryable provider failure classification
- fault-injection and per-adapter conformance reports
- safe deploy, doctor, upgrade, rollback, and recovery evidence
- scoped credentials, cost/rate controls, and content-private operations
- [x] searchable API reference generated from the versioned OpenAPI contract

## Next — Cloudflare and FolioMCP proof

- Workers runtime using the same public API
- D1 metadata/outbox, R2 payloads, and Queues/DLQ
- Cloudflare Email Sending transport and recipient event normalization
- capability-aware 50-recipient and 5 MiB validation
- plan-first deploy, doctor, upgrade, rollback, and cost evidence
- identical shared conformance and fault-injection suite
- provider switch without application-code changes
- controlled non-critical FolioMCP dogfood

Cloudflare Email Sending is currently Beta. HayaSend will keep that status
visible until both Cloudflare's service status and HayaSend's evidence justify
changing it.

## Then — Agent-safe policy

- actor, application, agent, and intent identity
- draft, send, and external-send permission separation
- recipient/domain allowlists and deny rules
- hourly/daily send and cost budgets
- approval gates for sensitive, external, attachment, and high-volume sends
- sandbox sink, preview, kill switch, and immutable audit
- MCP only as an interface over enforced policy

## Parked until the proof is complete

- inbound alias routing, automatic forwarding, and ARC preservation
- more language SDK gates beyond the shared provider conformance work
- visual template-product expansion
- contacts, broadcasts, journeys, and marketing automation
- managed multi-tenant content data plane
- SMS, push, chat, or a general notification workflow builder

The existing AWS receiving implementation remains supported, but it does not
set the order of new work.
